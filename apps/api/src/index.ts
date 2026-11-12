import { buildApp } from "./app.js";

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`api listening on :${port} (${app.db.driver})`);
