const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export function id(prefix: string): string {
  let s = "";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (const b of bytes) s += ALPHABET[b % 36];
  return `${prefix}_${s}`;
}
export const newId = { run: () => id("run"), task: () => id("tsk"), tenant: () => id("tnt"), file: () => id("fil"), dev: () => id("dev"), sec: () => id("sec"), conv: () => id("cnv"), msg: () => id("msg"), up: () => id("upl"), inv: () => id("inv") };
