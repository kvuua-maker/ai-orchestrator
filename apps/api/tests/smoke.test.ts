import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("walking skeleton", () => {
  it("healthz", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
  });

  it("meta exposes mobile features", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/meta" });
    const b = r.json();
    expect(b.api_version).toBeTruthy();
    expect(b.features.polling).toBe(true);
    expect(b.features.presigned_upload).toBe(true);
  });
});
