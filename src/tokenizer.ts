import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { getEncoding } from "js-tiktoken";
import type { Config } from "./config.ts";
import { config } from "./config.ts";

export type TokenCounter = (text: string) => number;

const DEFAULT_HF_MODEL = "BAAI/bge-m3";
const DEFAULT_BGE_REVISION = "5617a9f61b028005a4858fdac845db406aefb181";
const OPENAI_CL100K_MODELS = new Set([
	"text-embedding-3-small",
	"text-embedding-3-large",
	"text-embedding-ada-002",
]);
const tokenizerPromises = new Map<string, Promise<TokenCounter>>();

interface HuggingFaceTokenizerFiles {
	tokenizer: Record<string, unknown>;
	config: Record<string, unknown>;
}

async function loadJsonFile(
	url: string,
	filePath: string,
	fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const response = await fetcher(url);
	if (!response.ok) {
		throw new Error(`Téléchargement du tokenizer impossible (${response.status}): ${url}`);
	}
	const contents = new Uint8Array(await response.arrayBuffer());
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	await writeFile(temporaryPath, contents);
	await rename(temporaryPath, filePath);
	return JSON.parse(new TextDecoder().decode(contents)) as Record<string, unknown>;
}

async function loadHuggingFaceTokenizer(
	model: string,
	revision: string,
	cacheDir: string,
	fetcher: typeof fetch,
): Promise<HuggingFaceTokenizerFiles> {
	if (!/^[\w.-]+\/[\w.-]+$/u.test(model)) {
		throw new Error(`EMBEDDING_TOKENIZER_MODEL invalide (« ${model} »).`);
	}
	if (!/^[\w.-]+$/u.test(revision)) {
		throw new Error(`EMBEDDING_TOKENIZER_REVISION invalide (« ${revision} »).`);
	}
	const cacheKey = `${model.replace("/", "--")}--${revision}`;
	const modelCacheDir = join(cacheDir, cacheKey);
	await mkdir(modelCacheDir, { recursive: true });
	const baseUrl = `https://huggingface.co/${model}/resolve/${revision}`;
	const [tokenizer, tokenizerConfig] = await Promise.all([
		loadJsonFile(`${baseUrl}/tokenizer.json`, join(modelCacheDir, "tokenizer.json"), fetcher),
		loadJsonFile(
			`${baseUrl}/tokenizer_config.json`,
			join(modelCacheDir, "tokenizer_config.json"),
			fetcher,
		),
	]);
	return { tokenizer, config: tokenizerConfig };
}

export async function createHuggingFaceTokenCounter(
	model: string,
	revision = "main",
	cacheDir = join(homedir(), ".cache", "ocis-qdrant-indexer", "tokenizers"),
	fetcher: typeof fetch = fetch,
): Promise<TokenCounter> {
	const files = await loadHuggingFaceTokenizer(model, revision, cacheDir, fetcher);
	const tokenizer = new Tokenizer(files.tokenizer, files.config);
	return (text) => tokenizer.encode(text).ids.length;
}

export async function createEmbeddingTokenCounter(
	configuration: Config = config,
	fetcher: typeof fetch = fetch,
): Promise<TokenCounter> {
	const cacheDir =
		configuration.embeddingTokenizerCacheDir ||
		join(homedir(), ".cache", "ocis-qdrant-indexer", "tokenizers");
	if (configuration.embeddingTokenizerModel) {
		const revision = configuration.embeddingTokenizerRevision || "main";
		return createHuggingFaceTokenCounter(
			configuration.embeddingTokenizerModel,
			revision,
			cacheDir,
			fetcher,
		);
	}

	if (configuration.embeddingProvider === "openai") {
		if (!OPENAI_CL100K_MODELS.has(configuration.openaiModel)) {
			throw new Error(
				`Aucun tokenizer officiel connu pour ${configuration.openaiModel}. ` +
					"Configurez EMBEDDING_TOKENIZER_MODEL avec son tokenizer Hugging Face.",
			);
		}
		const encoding = getEncoding("cl100k_base");
		return (text) => encoding.encode(text).length;
	}

	const isBgeM3 =
		(configuration.embeddingProvider === "cloudflare" &&
			configuration.cloudflareModel.toLowerCase().endsWith("/bge-m3")) ||
		(configuration.embeddingProvider === "ollama" &&
			/^bge-m3(?::|$)/iu.test(configuration.ollamaModel));
	if (isBgeM3) {
		return createHuggingFaceTokenCounter(
			DEFAULT_HF_MODEL,
			configuration.embeddingTokenizerRevision || DEFAULT_BGE_REVISION,
			cacheDir,
			fetcher,
		);
	}

	throw new Error(
		`Aucun tokenizer officiel connu pour ${configuration.embeddingProvider}. ` +
			"Configurez EMBEDDING_TOKENIZER_MODEL avec le tokenizer Hugging Face correspondant.",
	);
}

export function getEmbeddingTokenCounter(configuration: Config = config): Promise<TokenCounter> {
	const key = JSON.stringify([
		configuration.embeddingProvider,
		configuration.cloudflareModel,
		configuration.openaiModel,
		configuration.ollamaModel,
		configuration.embeddingTokenizerModel,
		configuration.embeddingTokenizerRevision,
		configuration.embeddingTokenizerCacheDir,
	]);
	let promise = tokenizerPromises.get(key);
	if (!promise) {
		promise = createEmbeddingTokenCounter(configuration);
		tokenizerPromises.set(key, promise);
		promise.catch(() => tokenizerPromises.delete(key));
	}
	return promise;
}
