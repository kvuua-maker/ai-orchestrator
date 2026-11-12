import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

let asrPromise: Promise<any> | null = null;
const MODEL = process.env.WHISPER_MODEL ?? "Xenova/whisper-base";

async function getAsr() {
  if (!asrPromise) {
    asrPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = process.env.WHISPER_CACHE ?? join(tmpdir(), "aio-whisper");
      env.allowLocalModels = false;
      return pipeline("automatic-speech-recognition", MODEL, { dtype: "q8" });
    })().catch((e) => { asrPromise = null; throw e; });
  }
  return asrPromise;
}

/** Будь-який формат (webm/m4a/ogg/wav) → моно 16 кГц Float32, як вимагає Whisper. */
async function toPcm(audio: Buffer, ext: string): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), "aio-stt-"));
  const src = join(dir, `in.${ext}`);
  try {
    await writeFile(src, audio);
    const { stdout } = await run("ffmpeg", ["-v", "quiet", "-i", src, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"],
      { maxBuffer: 96 * 1024 * 1024, encoding: "buffer" as any });
    const buf = stdout as unknown as Buffer;
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const EXT: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/m4a": "m4a",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
};

export interface SttResult { text: string; ms: number; model: string; seconds: number }

export async function transcribe(audio: Buffer, mime: string, lang = "ukrainian"): Promise<SttResult> {
  if (audio.length < 2000) throw new Error("аудіо занадто коротке");
  const t0 = Date.now();
  const pcm = await toPcm(audio, EXT[mime.split(";")[0]!.trim()] ?? "webm");
  const seconds = pcm.length / 16000;
  if (seconds < 0.3) throw new Error("запис занадто короткий");

  const asr = await getAsr();
  const out = await asr(pcm, { language: lang, task: "transcribe" });
  const text = String(out?.text ?? "").trim();
  return { text, ms: Date.now() - t0, model: MODEL, seconds: Math.round(seconds * 10) / 10 };
}
