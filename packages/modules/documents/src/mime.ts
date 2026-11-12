/** Визначення типу за магічними байтами, а не за розширенням (§13.3). */
export function detectMime(bytes: Uint8Array, filename = ""): string {
  const b = bytes;
  const hex = (n: number, o = 0) => [...b.slice(o, o + n)].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (b.length >= 4 && hex(4) === "25504446") return "application/pdf";            // %PDF
  if (b.length >= 3 && hex(2) === "ffd8") return "image/jpeg";
  if (b.length >= 8 && hex(8) === "89504e470d0a1a0a") return "image/png";
  if (b.length >= 4 && hex(4) === "47494638") return "image/gif";
  if (b.length >= 4 && hex(4, 0) === "504b0304") {                                  // ZIP-контейнер
    return /\.docx$/i.test(filename) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : /\.xlsx$/i.test(filename) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/zip";
  }
  // текст: валідний UTF-8 без NUL
  if (b.length && !b.includes(0)) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(b); return "text/plain"; } catch { /* not text */ }
  }
  return "application/octet-stream";
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function checkSize(bytes: number, limit = MAX_FILE_BYTES): { ok: boolean; reason?: string } {
  if (bytes === 0) return { ok: false, reason: "empty_file" };
  if (bytes > limit) return { ok: false, reason: "file_too_large" };
  return { ok: true };
}
