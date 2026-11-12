import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const H = { "x-tenant-id": "tnt_demo0001" };
beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

async function upload(content: string, name = "receipt.txt") {
  const pre = await app.inject({ method: "POST", url: "/v1/uploads/presign", headers: H,
    payload: { filename: name, mime: "text/plain", sizeBytes: content.length } });
  const { uploadId } = pre.json();
  const put = await app.inject({ method: "PUT", url: `/v1/uploads/${uploadId}/parts/1`, headers: { ...H, "content-type": "application/octet-stream" }, payload: Buffer.from(content) });
  expect(put.statusCode).toBe(200);
  const done = await app.inject({ method: "POST", url: `/v1/uploads/${uploadId}/complete`, headers: H, payload: {} });
  return done;
}

describe("artifacts end-to-end", () => {
  it("upload → complete → скачування за підписаним URL", async () => {
    const done = await upload("Чек №42, сума 113.00");
    expect(done.statusCode).toBe(200);
    const body = done.json();
    expect(body.artifact.key).toMatch(/^[a-f0-9]{64}$/);
    expect(body.artifact.sha256).toHaveLength(64);

    const dl = await app.inject({ method: "GET", url: body.url, headers: H });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain("113.00");
  });

  it("дубль вмісту → той самий ключ (дедуплікація)", async () => {
    const a = (await upload("identical-content")).json();
    const b = (await upload("identical-content")).json();
    expect(a.artifact.key).toBe(b.artifact.key);
  });

  it("без підпису → 401", async () => {
    const a = (await upload("no-sign")).json();
    const r = await app.inject({ method: "GET", url: `/v1/artifacts/${a.artifact.key}`, headers: H });
    expect(r.statusCode).toBe(401);
  });

  it("підмінений підпис → 403", async () => {
    const a = (await upload("tampered")).json();
    const r = await app.inject({ method: "GET", url: `/v1/artifacts/${a.artifact.key}?exp=9999999999&sig=${"0".repeat(64)}`, headers: H });
    expect(r.statusCode).toBe(403);
  });

  it("чужий тенант не бачить артефакт", async () => {
    const a = (await upload("private-artifact")).json();
    const r = await app.inject({ method: "GET", url: a.url, headers: { "x-tenant-id": "tnt_other001" } });
    expect(r.statusCode).toBe(404);
  });
});
