import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OcisDrive } from "./ocis.ts";

export interface StoredUserCredentials {
	userId: string;
	username: string;
	pat: string;
	drives: OcisDrive[];
}

interface EncryptedUserRow {
	user_id: string;
	username: string;
	secret_ciphertext: Uint8Array;
	secret_nonce: Uint8Array;
	secret_tag: Uint8Array;
}

function encryptionKey(value: string): Buffer {
	const key = /^[0-9a-f]{64}$/i.test(value)
		? Buffer.from(value, "hex")
		: Buffer.from(value, "base64");
	if (key.length !== 32) {
		throw new Error("USER_STORE_ENCRYPTION_KEY doit être une clé de 32 octets en base64 ou hex.");
	}
	return key;
}

export class UserCredentialStore {
	private database: Database;
	private key: Buffer;

	constructor(databasePath: string, key: string) {
		this.key = encryptionKey(key);
		mkdirSync(dirname(databasePath), { recursive: true });
		this.database = new Database(databasePath);
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS users (
				user_id TEXT PRIMARY KEY,
				username TEXT NOT NULL,
				secret_ciphertext BLOB NOT NULL,
				secret_nonce BLOB NOT NULL,
				secret_tag BLOB NOT NULL
			)
		`);
	}

	save(user: StoredUserCredentials): void {
		if (!user.userId || !user.username || !user.pat) {
			throw new Error("Identité et PAT ownCloud requis pour enregistrer un utilisateur.");
		}
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(Buffer.from(user.userId));
		const secret = JSON.stringify({ pat: user.pat, drives: user.drives });
		const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
		this.database
			.query(
				`INSERT INTO users (user_id, username, secret_ciphertext, secret_nonce, secret_tag)
				 VALUES ($userId, $username, $ciphertext, $nonce, $tag)
				 ON CONFLICT(user_id) DO UPDATE SET
				 username = excluded.username,
				 secret_ciphertext = excluded.secret_ciphertext,
				 secret_nonce = excluded.secret_nonce,
				 secret_tag = excluded.secret_tag`,
			)
			.run({
				$userId: user.userId,
				$username: user.username,
				$ciphertext: ciphertext,
				$nonce: nonce,
				$tag: cipher.getAuthTag(),
			});
	}

	get(userId: string): StoredUserCredentials | undefined {
		const row = this.database
			.query<EncryptedUserRow, [string]>(
				"SELECT user_id, username, secret_ciphertext, secret_nonce, secret_tag FROM users WHERE user_id = ?",
			)
			.get(userId);
		return row ? this.decrypt(row) : undefined;
	}

	list(): StoredUserCredentials[] {
		const rows = this.database
			.query<EncryptedUserRow, []>(
				"SELECT user_id, username, secret_ciphertext, secret_nonce, secret_tag FROM users ORDER BY user_id",
			)
			.all();
		return rows.map((row) => this.decrypt(row));
	}

	remove(userId: string): void {
		this.database.query("DELETE FROM users WHERE user_id = ?").run(userId);
	}

	close(): void {
		this.database.close();
	}

	private decrypt(row: EncryptedUserRow): StoredUserCredentials {
		const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.secret_nonce));
		decipher.setAAD(Buffer.from(row.user_id));
		decipher.setAuthTag(Buffer.from(row.secret_tag));
		const secretJson = Buffer.concat([
			decipher.update(Buffer.from(row.secret_ciphertext)),
			decipher.final(),
		]).toString("utf8");
		const secret = JSON.parse(secretJson) as { pat?: unknown; drives?: unknown };
		if (typeof secret.pat !== "string" || !Array.isArray(secret.drives)) {
			throw new Error("Les données chiffrées de l'utilisateur sont invalides.");
		}
		return {
			userId: row.user_id,
			username: row.username,
			pat: secret.pat,
			drives: secret.drives as OcisDrive[],
		};
	}
}
