import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserCredentialStore } from "./user-store.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "ocis-user-store-"));
	directories.push(directory);
	return { directory, path: join(directory, "users.sqlite") };
}

describe("UserCredentialStore", () => {
	it("persists user credentials encrypted and restores authorized spaces", async () => {
		const { path, directory } = await fixture();
		const key = Buffer.alloc(32, 7).toString("base64");
		const store = new UserCredentialStore(path, key);
		store.save({
			userId: "canonical-alice",
			username: "alice",
			pat: "alice-secret-pat",
			drives: [{ id: "drive-a", name: "Alice files", driveType: "personal" }],
		});

		expect(store.get("canonical-alice")).toEqual({
			userId: "canonical-alice",
			username: "alice",
			pat: "alice-secret-pat",
			drives: [{ id: "drive-a", name: "Alice files", driveType: "personal" }],
		});
		const database = await readFile(path);
		expect(database.includes(Buffer.from("alice-secret-pat"))).toBe(false);
		expect(database.includes(Buffer.from("drive-a"))).toBe(false);
		expect(database.includes(Buffer.from("Alice files"))).toBe(false);
		store.close();

		const reopened = new UserCredentialStore(path, key);
		expect(reopened.list()).toHaveLength(1);
		expect(reopened.get("canonical-alice")?.pat).toBe("alice-secret-pat");
		reopened.close();
		await rm(directory, { recursive: true, force: true });
		directories.splice(directories.indexOf(directory), 1);
	});

	it("refuses to decrypt stored credentials with a different deployment key", async () => {
		const { path } = await fixture();
		const store = new UserCredentialStore(path, Buffer.alloc(32, 1).toString("base64"));
		store.save({ userId: "alice", username: "alice", pat: "secret", drives: [] });
		store.close();

		const wrongKey = new UserCredentialStore(path, Buffer.alloc(32, 2).toString("base64"));
		expect(() => wrongKey.get("alice")).toThrow();
		wrongKey.close();
	});

	it("detects ciphertext tampering through the GCM authentication tag", async () => {
		const { path } = await fixture();
		const key = Buffer.alloc(32, 4).toString("base64");
		const store = new UserCredentialStore(path, key);
		store.save({ userId: "alice", username: "alice", pat: "secret", drives: [] });
		store.close();

		const database = new Database(path);
		const row = database
			.query("SELECT secret_ciphertext FROM users WHERE user_id = ?")
			.get("alice") as { secret_ciphertext: Uint8Array };
		const corrupted = Buffer.from(row.secret_ciphertext);
		corrupted[0] = corrupted[0]! ^ 1;
		database
			.query("UPDATE users SET secret_ciphertext = ? WHERE user_id = ?")
			.run(corrupted, "alice");
		database.close();

		const reopened = new UserCredentialStore(path, key);
		expect(() => reopened.get("alice")).toThrow();
		reopened.close();
	});

	it("validates the deployment encryption key before opening storage", async () => {
		const { path } = await fixture();
		expect(() => new UserCredentialStore(path, "too-short")).toThrow("USER_STORE_ENCRYPTION_KEY");
	});

	it("creates a durable SQLite-backed user registry", async () => {
		const { path } = await fixture();
		const store = new UserCredentialStore(path, Buffer.alloc(32, 3).toString("base64"));
		store.save({ userId: "bob", username: "bob", pat: "bob-pat", drives: [] });
		store.close();

		const database = new Database(path, { readonly: true });
		expect(database.query("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
		database.close();
	});
});
