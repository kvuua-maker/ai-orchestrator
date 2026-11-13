import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "./sdk.js";

const run = promisify(execFile);

/**
 * video.create — збирає відеофайл зі сценарію: кадри + субтитри + музика, через ffmpeg.
 * Кадри бере з Pexels (якщо є ключ) або генерує градієнтні фони — без ключа теж працює.
 */

interface Scene { text: string; imageUrl?: string; seconds?: number }

async function pexelsImage(query: string, key: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
      { headers: { authorization: key }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    return j?.photos?.[0]?.src?.large2x ?? j?.photos?.[0]?.src?.large ?? null;
  } catch { return null; }
}

async function download(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch { return false; }
}

const COLORS = ["#12224a", "#1d1440", "#0f2a2a", "#2a1a10", "#101a34", "#241033"];

/** Чистий текст для drawtext: екрануємо двокрапки, лапки й відсотки. */
function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%").replace(/\n/g, " ");
}

export const videoCreate = defineTool({
  name: "video.create",
  version: "1.0.0",
  description:
    "Create an MP4 video from a text script: each scene becomes a frame with a caption (and stock footage from Pexels " +
    "when a key is configured), optionally with background music. Returns a downloadable artifact link.",
  input: z.object({
    title: z.string().min(2).max(120).optional(),
    scenes: z.array(z.object({
      text: z.string().min(1).max(300),
      imageUrl: z.string().url().optional(),
      seconds: z.number().min(1).max(15).optional(),
    })).min(1).max(12),
    musicUrl: z.string().url().optional(),
    width: z.number().int().min(320).max(1920).optional(),
    height: z.number().int().min(320).max(1920).optional(),
  }),
  output: z.object({ artifactKey: z.string(), url: z.string(), seconds: z.number(), scenes: z.number(), size: z.number() }),
  risk: "write", effectClass: "non_idempotent", costClass: "cheap",
  scopes: ["artifacts:write"], agents: ["synthesizer", "data"],
  timeoutMs: 120_000, maxRetries: 0,
  async execute(input, ctx) {
    const W = input.width ?? 1280, H = input.height ?? 720;
    const dir = await mkdtemp(join(tmpdir(), "aio-video-"));
    const { resolveKey } = await import("../integrations/store.js");
    const pexels = resolveKey("pexels") ?? process.env.PEXELS_API_KEY ?? null;

    try {
      const parts: string[] = [];
      let total = 0;

      for (let i = 0; i < input.scenes.length; i++) {
        const sc = input.scenes[i]!;
        const secs = sc.seconds ?? 4;
        total += secs;
        const img = join(dir, `s${i}.png`);

        let ok = false;
        if (sc.imageUrl) ok = await download(sc.imageUrl, img);
        if (!ok && pexels) {
          const url = await pexelsImage(sc.text.slice(0, 60), pexels);
          if (url) ok = await download(url, img);
        }
        if (!ok) {
          // фон генеруємо самі — відео працює навіть без ключів і без інтернету
          const color = COLORS[i % COLORS.length]!;
          await run("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:d=1`, "-frames:v", "1", img]);
        }

        const out = join(dir, `c${i}.mp4`);
        const caption = esc(sc.text.slice(0, 180));
        await run("ffmpeg", [
          "-y", "-loop", "1", "-t", String(secs), "-i", img,
          "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
                 `drawbox=y=ih-160:color=black@0.55:width=iw:height=160:t=fill,` +
                 `drawtext=text='${caption}':fontcolor=white:fontsize=34:x=60:y=h-120:line_spacing=8`,
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "25", "-t", String(secs), out,
        ], { maxBuffer: 64 * 1024 * 1024 });
        parts.push(out);
      }

      const list = join(dir, "list.txt");
      await writeFile(list, parts.map((p) => `file '${p}'`).join("\n"));
      const silent = join(dir, "silent.mp4");
      await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent], { maxBuffer: 64 * 1024 * 1024 });

      const final = join(dir, "out.mp4");
      if (input.musicUrl) {
        const music = join(dir, "music.mp3");
        const gotMusic = await download(input.musicUrl, music);
        if (gotMusic) {
          await run("ffmpeg", ["-y", "-i", silent, "-i", music, "-shortest", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", final],
            { maxBuffer: 64 * 1024 * 1024 }).catch(async () => { await run("cp", [silent, final]); });
        } else {
          await run("cp", [silent, final]);
        }
      } else {
        await run("cp", [silent, final]);
      }

      const bytes = await readFile(final);
      const artifacts = ctx.artifacts!;
      const stored = await artifacts.put({ bytes, mime: "video/mp4", name: `${(input.title ?? "video").replace(/[^\wа-яіїєґ -]/gi, "").trim() || "video"}.mp4` });
      const signed = artifacts.sign(stored.key, 24 * 3600);
      const base = process.env.PUBLIC_BASE_URL ?? "";
      const url = `${base}/v1/artifacts/${stored.key}?exp=${signed.exp}&sig=${signed.sig}`;
      return { data: { artifactKey: stored.key, url, seconds: total, scenes: input.scenes.length, size: bytes.length } };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
  async simulate({ scenes }) {
    return { data: { artifactKey: "dry-run", url: "", seconds: scenes.length * 4, scenes: scenes.length, size: 0 } };
  },
});
