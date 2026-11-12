/** Мінімальний semver: exact, ^, ~, *, >=. Без залежностей (§3.2.2). */
export interface Version { major: number; minor: number; patch: number }

export function parseVersion(v: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compare(a: string, b: string): number {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/** Діапазони можуть бути частковими: "1", "1.2" → 1.0.0, 1.2.0. */
export function parseRangeBase(v: string): Version | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}
const asString = (v: Version) => `${v.major}.${v.minor}.${v.patch}`;

/** Чи задовольняє версія діапазон. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const r = range.trim();
  if (r === "*" || r === "" || r === "latest") return true;

  if (r.startsWith("^")) {
    const base = parseRangeBase(r.slice(1));
    if (!base) return false;
    if (base.major > 0) return v.major === base.major && compare(version, asString(base)) >= 0;
    if (base.minor > 0) return v.major === 0 && v.minor === base.minor && v.patch >= base.patch;
    return v.major === 0 && v.minor === 0 && v.patch === base.patch;
  }
  if (r.startsWith("~")) {
    const base = parseRangeBase(r.slice(1));
    if (!base) return false;
    return v.major === base.major && v.minor === base.minor && v.patch >= base.patch;
  }
  if (r.startsWith(">=")) {
    const base = parseRangeBase(r.slice(2));
    return !!base && compare(version, asString(base)) >= 0;
  }
  return version === r;
}

/** Найвища версія, що задовольняє діапазон. */
export function maxSatisfying(versions: string[], range: string): string | null {
  const ok = versions.filter((v) => satisfies(v, range)).sort(compare);
  return ok.at(-1) ?? null;
}
