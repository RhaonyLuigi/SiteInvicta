import { db, runtime } from "../server/runtime.js";
if (!db) throw new Error("Configure DATABASE_URL.");
console.log("Tarefas concluídas:", await runtime.tasks());
await db.close();
