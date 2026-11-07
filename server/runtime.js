import { configuration } from "./config.js";
import { database, localKey } from "./db.js";
import { createApp } from "./app.js";

export const config = configuration();
await localKey(config);
export const db = await database(config);
export const runtime = createApp({ db, config });
