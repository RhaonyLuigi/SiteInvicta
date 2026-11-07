import { configuration } from "../server/config.js";
import { database, migrate } from "../server/db.js";
const db = await database(configuration());
if (!db) throw new Error("Configure DATABASE_URL.");
await migrate(db);
await db.close();
console.log("Banco atualizado.");
