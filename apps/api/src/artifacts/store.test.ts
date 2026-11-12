import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "./store.js";

let dir: string, store: LocalArtifactStore;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "aio-art-")); store = new LocalArtifactStore(dir, "test-secret"); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("LocalArtifactStore", () => {
  it("зберігає і читає байти", async () => {
    const payload = Buffer.from("звіт за листопад");
    const a = await store.put({ bytes: payload, mime: "text/plain", name: "report.txt" });
    expect(a.key).toHaveLength(64);
    expect(await store.get(a.key)).toEqual(payload);
  });

  it("дедуплікує однаковий вміст", async () => {
    const buf = Buffer.from("same-content");
    const a = await store.put({ bytes: buf, mime: "text/plain" });
    const b = await store.put({ bytes: Buffer.from("same-content"), mime: "text/plain" });
    expect(a.key).toBe(b.key);
  });

  it("різний вміст → різні ключі", async () => {
    const a = await store.put({ bytes: Buffer.from("a"), mime: "text/plain" });
    const b = await store.put({ bytes: Buffer.from("b"), mime: "text/plain" });
    expect(a.key).not.toBe(b.key);
  });

  it("підпис валідний до exp", async () => {
    const a = await store.put({ bytes: Buffer.from("x"), mime: "text/plain" });
    const { exp, sig } = store.sign(a.key, 60);
    expect(store.verify(a.key, exp, sig)).toEqual({ ok: true });
  });

  it("прострочений підпис відхиляється", async () => {
    const a = await store.put({ bytes: Buffer.from("y"), mime: "text/plain" });
    const { exp, sig } = store.sign(a.key, 1, new Date(Date.now() - 3600_000));
    expect(store.verify(a.key, exp, sig)).toEqual({ ok: false, reason: "expired" });
  });

  it("підміна ключа ламає підпис", async () => {
    const a = await store.put({ bytes: Buffer.from("z"), mime: "text/plain" });
    const b = await store.put({ bytes: Buffer.from("w"), mime: "text/plain" });
    const { exp, sig } = store.sign(a.key, 60);
    expect(store.verify(b.key, exp, sig)).toEqual({ ok: false, reason: "bad_sig" });
  });

  it("path traversal у ключі відхиляється", async () => {
    await expect(store.get("../../etc/passwd")).rejects.toThrow();
  });
});
