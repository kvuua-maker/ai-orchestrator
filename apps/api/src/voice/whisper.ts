import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = promisify(execFile);
const MODEL = process.env.WHISPER_MODEL ?? "whisper-tiny";
const CACHE = process.env.WHISPER_CACHE ?? join(tmpdir(), "aio-whisper");
const WORKER = resolve(process.cwd(), "apps/api/scripts/stt-worker.mjs");

const EXT: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/m4a": "m4a",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
};

/** Постійний процес: модель вантажиться один раз, а не на кожен запит. */
class Worker {
  private child: ChildProcess | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private start(): ChildProcess {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout!.on("data", (chunk) => {
      this.buf += chunk.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready || msg.id === undefined) continue;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
      }
    });
    child.stderr!.on("data", (c) => process.stderr.write(`[stt] ${c}`));
    child.on("exit", () => {
      this.child = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("STT-процес завершився")); }
      this.pending.clear();
    });
    this.child = child;
    return child;
  }

  request(payload: Omit<any, "id">): Promise<any> {
    const child = this.start();
    const id = ++this.seq;
    return new Promise((resolveOut, rejectOut) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectOut(new Error("STT перевищив 120 с")); }, 120_000);
      this.pending.set(id, { resolve: resolveOut, reject: rejectOut, timer });
      child.stdin!.write(JSON.stringify({ ...payload, id }) + "\n");
    });
  }

  /** Прогрів: 0.5 с тиші змушує воркер завантажити модель заздалегідь. */
  warm() { this.request({ pcm: new Array(8000).fill(0), language: "ukrainian", model: MODEL, cacheDir: CACHE }).catch(() => {}); }
}

const worker = new Worker();
let warmed = false;

async function toPcm(audio: Buffer, ext: string): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), "aio-stt-"));
  const src = join(dir, `in.${ext}`);
  try {
    await writeFile(src, audio);
    const { stdout } = await run("ffmpeg",
      ["-v", "quiet", "-i", src, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"],
      { maxBuffer: 96 * 1024 * 1024, encoding: "buffer" as any });
    const buf = stdout as unknown as Buffer;
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface SttResult { text: string; ms: number; model: string; seconds: number; engine: string }

/** Викликати при старті сервера, щоб перший запис не чекав 10 с. */
export function preloadWhisper(): void {
  setTimeout(() => { try { worker.warm(); } catch { /* ignore */ } }, 500);
}

/** Groq: whisper-large-v3-turbo — найкраща точність для української, безкоштовний ліміт. */
async function viaGroq(audio: Buffer, mime: string, lang: string): Promise<SttResult | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const ext = EXT[mime.split(";")[0]!.trim()] ?? "webm";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `audio.${ext}`);
    form.append("model", process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo");
    form.append("language", lang.slice(0, 2) === "uk" ? "uk" : lang);
    form.append("response_format", "json");
    form.append("temperature", "0");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", headers: { authorization: `Bearer ${key}` }, body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const text = String(json?.text ?? "").trim();
    if (!text) return null;
    return { text, ms: Date.now() - t0, model: String(json?.model ?? "whisper-large-v3-turbo"), seconds: 0, engine: "groq" };
  } catch { return null; }
}

export async function transcribe(audio: Buffer, mime: string, lang = "ukrainian"): Promise<SttResult> {
  if (audio.length < 2000) throw new Error("аудіо занадто коротке");
  const t0 = Date.now();

  // 1) Groq (найвища точність) — якщо є ключ
  const groq = await viaGroq(audio, mime, lang);
  if (groq) return { ...groq, ms: Date.now() - t0 };

  // 2) локальний whisper — фолбек без інтернету
  if (!warmed) { warmed = true; worker.warm(); }
  const pcm = await toPcm(audio, EXT[mime.split(";")[0]!.trim()] ?? "webm");
  const seconds = pcm.length / 16000;
  if (seconds < 0.3) throw new Error("запис занадто короткий");
  // порожня тиша: не турбуємо модель
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 32) { const v = Math.abs(pcm[i]!); if (v > peak) peak = v; }
  if (peak < 0.004) return { text: "", ms: Date.now() - t0, model: MODEL, seconds: Math.round(seconds * 10) / 10, engine: "silence" };

  const out = await worker.request({ pcm: Array.from(pcm), language: lang, model: MODEL, cacheDir: CACHE });
  return { text: String(out.text ?? ""), ms: Date.now() - t0, model: MODEL, seconds: Math.round(seconds * 10) / 10, engine: "whisper-worker" };
}
