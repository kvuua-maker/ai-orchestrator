import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoredArtifact {
  key: string;
  sha256: string;
  bytes: number;
  mime: string;
  name?: string;
}

export interface ArtifactStore {
  put(input: { bytes: Buffer; mime: string; name?: string }): Promise<StoredArtifact>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  sign(key: string, ttlSeconds: number, now?: Date): { exp: number; sig: string };
  verify(key: string, exp: number, sig: string, now?: Date): { ok: true } | { ok: false; reason: "expired" | "bad_sig" };
  root: string;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Content-addressed: ключ = sha256, тому дублі не створюють нових файлів (§20.9). */
export class LocalArtifactStore implements ArtifactStore {
  constructor(readonly root: string, private readonly secret: string) {}

  private path(key: string) { return join(this.root, key.slice(0, 2), key); }

  async put({ bytes, mime, name }: { bytes: Buffer; mime: string; name?: string }): Promise<StoredArtifact> {
    const hash = sha256(bytes);
    const key = hash;                       // дедуплікація безкоштовно
    const p = this.path(key);
    if (!(await this.exists(key))) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    }
    return { key, sha256: hash, bytes: bytes.length, mime, name };
  }

  async get(key: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid artifact key");
    return readFile(this.path(key));
  }

  async exists(key: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(key)) return false;
    try { await stat(this.path(key)); return true; } catch { return false; }
  }

  sign(key: string, ttlSeconds: number, now = new Date()) {
    const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
    return { exp, sig: this.mac(key, exp) };
  }

  verify(key: string, exp: number, sig: string, now = new Date()) {
    if (Math.floor(now.getTime() / 1000) > exp) return { ok: false as const, reason: "expired" as const };
    const expected = this.mac(key, exp);
    const a = Buffer.from(sig, "hex"), b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false as const, reason: "bad_sig" as const };
    return { ok: true as const };
  }

  private mac(key: string, exp: number) {
    return createHmac("sha256", this.secret).update(`${key}.${exp}`).digest("hex");
  }
}

export function createArtifactStore() {
  return new LocalArtifactStore(
    process.env.ARTIFACT_ROOT ?? ".artifacts",
    process.env.ARTIFACT_SIGNING_KEY ?? process.env.VAULT_MASTER_KEY ?? "dev-artifact-key",
  );
}
