import { createDb, seed } from "./index.js";
const db = await createDb();
await seed(db);
console.log(`migrated (${db.driver})`);
await db.close();
