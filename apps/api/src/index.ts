import { buildApp } from "./app.js";

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";   // назовні — лише через проксі
await app.listen({ port, host });
console.log(`api listening on :${port} (${app.db.driver})`);
