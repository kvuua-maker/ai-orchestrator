/** База знань про моделі: не дає вигадувати неіснуючі комбінації (3GS 256GB). */

export interface ProductInterpretation {
  understood: string;
  canonical: string | null;
  issue: string | null;
  needsConfirm: boolean;
}

const IPHONE_STORAGE: Record<string, number[]> = {
  "3g": [8, 16], "3gs": [8, 16, 32], "4": [8, 16, 32], "4s": [8, 16, 32, 64],
  "5": [16, 32, 64], "5s": [16, 32, 64], "5c": [8, 16, 32],
  "se1": [16, 32, 64, 128],
  "se2": [64, 128, 256],
  "se3": [64, 128, 256],
  "6": [16, 32, 64, 128], "6s": [16, 32, 64, 128], "7": [32, 128, 256], "8": [64, 128, 256],
  "x": [64, 256], "xs": [64, 256, 512], "xr": [64, 128, 256],
  "11": [64, 128, 256], "12": [64, 128, 256], "13": [128, 256, 512], "14": [128, 256, 512],
  "15": [128, 256, 512], "16": [128, 256, 512],
};

const MODEL_LABEL: Record<string, string> = {
  "3g": "iPhone 3G (2008)", "3gs": "iPhone 3GS (2009)", "4": "iPhone 4", "4s": "iPhone 4s",
  "5": "iPhone 5", "5s": "iPhone 5s", "5c": "iPhone 5c",
  se1: "iPhone SE (1-ше покоління, 2016)",
  se2: "iPhone SE (2-ге покоління, 2020)",
  se3: "iPhone SE (3-тє покоління, 2022)",
  "6": "iPhone 6", "6s": "iPhone 6s", "7": "iPhone 7", "8": "iPhone 8",
  x: "iPhone X", xs: "iPhone XS", xr: "iPhone XR",
  "11": "iPhone 11", "12": "iPhone 12", "13": "iPhone 13", "14": "iPhone 14", "15": "iPhone 15", "16": "iPhone 16",
};

/** Розпізнає модель із тексту (включно з «ес е», «SE 2», «15 про макс»). */
export function parsePhone(text: string): { key: string | null; storage: number | null; extra: string } {
  const t = text.toLowerCase()
    .replace(/ес\s*е/g, "se").replace(/эс\s*е/g, "se")
    .replace(/гб|гігабайт\w*|\bgb\b/gi, "gb")
    .replace(/(\d)\s*gb/g, "$1 gb");

  const storageMatch = t.match(/(\d{2,4})\s*gb/);
  const storage = storageMatch ? Number(storageMatch[1]) : null;

  let key: string | null = null;
  if (/\bse\b/.test(t)) {
    if (/\b(3|трет)\b/.test(t)) key = "se3";
    else if (/\b(1|перш)\b/.test(t)) key = "se1";
    else key = "se2";                       // «iPhone SE 256» без покоління = найпоширеніший SE 2020
  } else {
    const m = t.match(/iphone\s*(3gs|3g|4s|5s|5c|x[rs]?|1[1-6]|[4-9])\b/);
    if (m) key = m[1] ?? null;
  }

  const extra = /max|макс/i.test(t) ? "Max" : /plus|плюс/i.test(t) ? "Plus" : /pro|про/i.test(t) ? "Pro" : "";
  return { key, storage, extra };
}

/** Перевіряє комбінацію і формулює людською мовою, як агент зрозумів задачу. */
export function interpretPhoneQuery(text: string): ProductInterpretation | null {
  const { key, storage, extra } = parsePhone(text);
  if (!key) return null;

  const label = MODEL_LABEL[key] ?? `iPhone ${key}`;
  const allowed = IPHONE_STORAGE[key] ?? null;
  const model = `${label}${extra ? " " + extra : ""}`;

  if (storage && allowed && !allowed.includes(storage)) {
    const variant = extra ? ` ${extra}` : "";
    return {
      understood: `${model}, ${storage} ГБ`,
      canonical: null,
      issue: `У моделі ${label}${variant} не було версії ${storage} ГБ — доступні ${allowed.join(", ")} ГБ.`,
      needsConfirm: true,
    };
  }

  if (!storage) {
    return {
      understood: model,
      canonical: `${model} — обсяг пам'яті уточніть`,
      issue: null,
      needsConfirm: true,
    };
  }

  return { understood: `${model}, ${storage} ГБ`, canonical: `${model} ${storage} GB`, issue: null, needsConfirm: true };
}

/** Чи це задача пошуку товару/ціни — тоді підтвердження обов'язкове. */
export function isProductSearch(text: string): boolean {
  const t = text.toLowerCase();
  return /(iphone|samsung|xiaomi|pixel|macbook|ноутбук|телефон|смартфон|навушник|пилосос)/.test(t)
    && /(цін|коштує|купити|знайди|порівняй|скільки|наявн|модел|гб|gb)/.test(t);
}

/** Пошуковий запит для маркетплейсів: латиниця, без дужок і зайвих слів. */
export function searchQuery(text: string): string {
  const { key, storage } = parsePhone(text);
  if (key) {
    const gen: Record<string, string> = { se1: "", se2: "2020", se3: "2022" };
    const model = key.startsWith("se") ? `iPhone SE ${gen[key] ?? ""}` : `iPhone ${key.toUpperCase()}`;
    return `${model}${storage ? ` ${storage}GB` : ""}`.replace(/\s+/g, " ").trim();
  }
  return text.replace(/\([^)]*\)/g, " ").replace(/[^\w\s.]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}
