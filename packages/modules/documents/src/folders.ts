/** Сортування документів по теках за метаданими (§13.9). */
export interface DocMeta {
  key: string;
  name: string;
  date?: string | null;
  merchant?: string | null;
  total?: number | null;
  sha256: string;
}

export interface Move { from: string; to: string; reason: string }

export function slug(s: string, max = 40): string {
  return s.toLowerCase().normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, max) || "unknown";
}

export function planFolders(
  docs: DocMeta[],
  opts: { root?: string; pattern?: "yyyy/mm/merchant" | "yyyy/mm" } = {},
): { moves: Move[]; collisions: string[] } {
  const root = (opts.root ?? "documents").replace(/\/+$/, "");
  const pattern = opts.pattern ?? "yyyy/mm/merchant";
  const used = new Map<string, number>();
  const moves: Move[] = [];
  const collisions: string[] = [];

  for (const d of docs) {
    const date = d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : "0000-00-00";
    const [yyyy, mm] = date.split("-");
    const parts = [root];
    if (pattern !== "yyyy/mm") parts.push(yyyy!, mm!);
    else parts.push(yyyy!, mm!);
    if (pattern === "yyyy/mm/merchant") parts.push(slug(d.merchant ?? "unknown"));

    const ext = (d.name.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? ".bin").toLowerCase();
    const base = `${date === "0000-00-00" ? "no-date" : date}-${d.total != null ? d.total.toFixed(2).replace(".", ",") : "no-amount"}`;
    let target = `${parts.join("/")}/${slug(base, 60)}${ext}`;
    const n = (used.get(target) ?? 0) + 1;
    if (n > 1) {
      collisions.push(target);
      target = target.replace(ext, `-${d.sha256.slice(0, 6)}${ext}`);   // детермінований суфікс
    }
    used.set(target, n);
    moves.push({ from: d.key, to: target, reason: "rule:date+merchant+amount" });
  }
  return { moves, collisions };
}
