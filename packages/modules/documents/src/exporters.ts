/** Генерація файлів з нормалізованих рядків (§13.8). Формати: xlsx, docx, pdf. */

export interface Row { [key: string]: string | number | null | undefined }

export interface ExportInput {
  title: string;
  columns: string[];
  rows: Row[];
  meta?: Record<string, string>;
}

const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export async function toXlsx(input: ExportInput): Promise<Buffer> {
  const ExcelJS: any = (await import("exceljs")).default ?? (await import("exceljs"));
  const wb = new ExcelJS.Workbook();
  wb.creator = "AI Orchestrator";
  wb.created = new Date();
  const ws = wb.addWorksheet(input.title.slice(0, 31) || "Sheet1");
  ws.columns = input.columns.map((c) => ({ header: c, key: c, width: Math.max(12, Math.min(40, c.length + 6)) }));
  ws.getRow(1).font = { bold: true };
  for (const r of input.rows) ws.addRow(Object.fromEntries(input.columns.map((c) => [c, r[c] ?? ""])));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: input.columns.length } };
  const total = input.rows.reduce((s, r) => s + (Number(r["Сума"]) || 0), 0);
  if (input.columns.includes("Сума") && input.rows.length) {
    const row = ws.addRow({ [input.columns[0] as string]: "Разом", "Сума": Math.round(total * 100) / 100 });
    row.font = { bold: true };
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export async function toDocx(input: ExportInput): Promise<Buffer> {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, HeadingLevel, TextRun } = await import("docx");
  const header = new TableRow({
    children: input.columns.map((c) => new TableCell({ children: [new Paragraph({ text: c, heading: HeadingLevel.HEADING_4 })] })),
  });
  const body = input.rows.map((r) => new TableRow({
    children: input.columns.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun(cell(r[c]))] })] })),
  }));
  const doc = new Document({
    creator: "AI Orchestrator",
    sections: [{
      children: [
        new Paragraph({ text: input.title, heading: HeadingLevel.HEADING_1 }),
        ...Object.entries(input.meta ?? {}).map(([k, v]) => new Paragraph({ children: [new TextRun({ text: `${k}: ${v}`, italics: true })] })),
        new Paragraph({ text: "" }),
        new Table({ rows: [header, ...body], width: { size: 100, type: "pct" as const } }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** Кирилиця у PDF: стандартні шрифти WinAnsi її не містять — використовуємо вбудований Helvetica лише для латиниці. */
export async function toPdf(input: ExportInput): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]); // A4
  let y = 800;
  const write = (text: string, size = 11, bold = false) => {
    const safe = asciiSafe(text);
    page.drawText(safe, { x: 40, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    y -= size + 6;
  };
  write(input.title, 16);
  for (const [k, v] of Object.entries(input.meta ?? {})) write(`${k}: ${v}`, 10);
  y -= 8;
  write(input.columns.join(" | "), 9);
  for (const r of input.rows) {
    if (y < 40) break;
    write(input.columns.map((c) => cell(r[c])).join(" | "), 9);
  }
  return Buffer.from(await doc.save());
}

/** PDF-стандартні шрифти не мають кирилиці: транслітеруємо, щоб не втратити текст. */
const TRANSLIT: Record<string, string> = {
  "а":"a","б":"b","в":"v","г":"h","ґ":"g","д":"d","е":"e","є":"ye","ж":"zh","з":"z","и":"y","і":"i",
  "ї":"yi","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u",
  "ф":"f","х":"kh","ц":"ts","ч":"ch","ш":"sh","щ":"shch","ь":"","ю":"yu","я":"ya",
  "А":"A","Б":"B","В":"V","Г":"H","Ґ":"G","Д":"D","Е":"E","Є":"Ye","Ж":"Zh","З":"Z","И":"Y","І":"I",
  "Ї":"Yi","Й":"Y","К":"K","Л":"L","М":"M","Н":"N","О":"O","П":"P","Р":"R","С":"S","Т":"T","У":"U",
  "Ф":"F","Х":"Kh","Ц":"Ts","Ч":"Ch","Ш":"Sh","Щ":"Shch","Ь":"","Ю":"Yu","Я":"Ya",
  "’":"'","ʼ":"'","«":'"',"»":'"',"—":"-","–":"-","№":"No.",
};

export function asciiSafe(s: string): string {
  let out = "";
  for (const ch of s) {
    if (Object.prototype.hasOwnProperty.call(TRANSLIT, ch)) out += TRANSLIT[ch];
    else if (/[\x20-\x7E]/.test(ch)) out += ch;
  }
  return out;
}

export async function exportFile(format: "xlsx" | "docx" | "pdf", input: ExportInput): Promise<{ bytes: Buffer; mime: string; name: string }> {
  const slug = input.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "report";
  if (format === "xlsx") return { bytes: await toXlsx(input), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: `${slug}.xlsx` };
  if (format === "docx") return { bytes: await toDocx(input), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: `${slug}.docx` };
  return { bytes: await toPdf(input), mime: "application/pdf", name: `${slug}.pdf` };
}
