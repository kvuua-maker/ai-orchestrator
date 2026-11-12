import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

const preflight = (origin: string) => app.inject({
  method: "OPTIONS", url: "/v1/runs",
  headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "x-tenant-id,content-type" },
});

describe("CORS для веб-клієнта", () => {
  it("дозволений origin отримує заголовки", async () => {
    const r = await preflight("http://localhost:3000");
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(String(r.headers["access-control-allow-headers"])).toContain("x-tenant-id");
    expect(String(r.headers["access-control-expose-headers"])).toContain("x-trace-id");
  });

  it("чужий origin НЕ отримує заголовків (браузер заблокує), але без 500", async () => {
    const r = await preflight("https://evil.example");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.statusCode).toBeLessThan(500);
  });

  it("запит без Origin (curl, сервер-сервер) не ламається", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
  });

  it("x-trace-id доступний клієнту", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz", headers: { origin: "http://localhost:3000" } });
    expect(r.headers["x-trace-id"]).toBeTruthy();
  });
});
