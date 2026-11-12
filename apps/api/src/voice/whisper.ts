import { execFile, spawn } from "node:child_process";
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

/**
 * Whisper в окремому процесі: fastembed і transformers тягнуть різні версії
 * onnxruntime, і в одному процесі вони конфліктують (`VERS_1.30.0 not found`).
 */
export async function transcribe(audio: Buffer, mime: string, lang = "ukrainian"): Promise<SttResult> {
  if (audio.length < 2000) throw new Error("аудіо занадто коротке");
  const t0 = Date.now();
  const pcm = await toPcm(audio, EXT[mime.split(";")[0]!.trim()] ?? "webm");
  const seconds = pcm.length / 16000;
  if (seconds < 0.3) throw new Error("запис занадто короткий");

  const payload = JSON.stringify({ pcm: Array.from(pcm), language: lang, model: MODEL, cacheDir: CACHE });
  const stdout = await new Promise<string>((resolveOut, rejectOut) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); rejectOut(new Error("STT перевищив 120 с")); }, 120_000);
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolveOut(out.trim());
      else rejectOut(new Error(`STT-процес завершився з кодом ${code}: ${err.slice(0, 200)}`));
    });
    child.on("error", (e) => { clearTimeout(timer); rejectOut(e); });
    child.stdin.write(payload);
    child.stdin.end();
  });

  let parsed: any = null;
  try { parsed = JSON.parse(stdout); } catch { /* нижче */ }
  if (!parsed) throw new Error("STT-процес не повернув відповідь");
  if (!parsed.ok) throw new Error(parsed.error);

  return { text: String(parsed.text ?? ""), ms: Date.now() - t0, model: MODEL, seconds: Math.round(seconds * 10) / 10, engine: "whisper-worker" };
}
