import { Pool } from "pg";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

export async function database(config) {
    if (config.databaseUrl) {
        const pool = new Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
        return {
            query: (text, values) => pool.query(text, values),
            async transaction(work) {
                const client = await pool.connect();
                try {
                    await client.query("BEGIN");
                    const result = await work(client);
                    await client.query("COMMIT");
                    return result;
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                } finally {
                    client.release();
                }
            },
            close: () => pool.end()
        };
    }
    if (config.production) return null;
    const { PGlite } = await import("@electric-sql/pglite");
    if (config.localPath !== ":memory:") await mkdir(dirname(resolve(config.localPath)), { recursive: true });
    const embedded = new PGlite(config.localPath === ":memory:" ? undefined : resolve(config.localPath));
    await embedded.waitReady;
    return {
        query: (text, values) => embedded.query(text, values),
        transaction: (work) => embedded.transaction(work),
        close: () => embedded.close()
    };
}

export async function migrate(db) {
    const folder = new URL("../db/", import.meta.url);
    const files = (await readdir(folder)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    await db.transaction(async (client) => {
        await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
        for (const name of files) {
            if ((await client.query("SELECT version FROM schema_migrations WHERE version=$1", [name])).rows.length) continue;
            const sql = await readFile(new URL(name, folder), "utf8");
            for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) await client.query(statement);
            await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [name]);
        }
    });
}

export async function localKey(config) {
    if (config.encryptionKey) return;
    if (config.production) return;
    if (config.localPath === ":memory:") {
        config.encryptionKey = randomBytes(32).toString("hex");
        return;
    }
    await mkdir(resolve(".data"), { recursive: true });
    const path = resolve(".data/encryption.key");
    try {
        config.encryptionKey = (await readFile(path, "utf8")).trim();
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const key = randomBytes(32).toString("hex");
        await writeFile(path, key, { flag: "wx", mode: 0o600 });
        config.encryptionKey = key;
    }
}
