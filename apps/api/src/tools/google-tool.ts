import { z } from "zod";
import { defineTool, ToolFailure } from "./sdk.js";

/** google.drive_search / google.gmail_search / google.gmail_send — після OAuth-підключення. */

async function token(ctx: any): Promise<string> {
  const { freshAccessToken } = await import("../integrations/google.js");
  const t = await freshAccessToken(ctx.tenantId).catch(() => null);
  if (!t) throw new ToolFailure("AUTH", "Google не підключено: натисніть «Підключити Google» на сторінці «Підключення».", false);
  return t;
}

export const googleDriveSearch = defineTool({
  name: "google.drive_search",
  version: "1.0.0",
  description: "Search the user's Google Drive by name or content and return file names, ids, mime types and links.",
  input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(25).optional() }),
  output: z.object({ files: z.array(z.object({ id: z.string(), name: z.string(), mime: z.string(), link: z.string() })) }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["google:read"], agents: ["synthesizer", "data"],
  timeoutMs: 20_000, maxRetries: 0,
  async execute({ query, limit }, ctx) {
    const at = await token(ctx);
    const params = new URLSearchParams({
      q: `name contains '${query.replace(/'/g, "")}' and trashed = false`,
      pageSize: String(limit ?? 10),
      fields: "files(id,name,mimeType,webViewLink)",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new ToolFailure("UPSTREAM_ERROR", `Google Drive: ${res.status}`, res.status >= 500);
    const j: any = await res.json();
    return { data: { files: (j.files ?? []).map((f: any) => ({ id: f.id, name: f.name, mime: f.mimeType, link: f.webViewLink ?? "" })) } };
  },
  async simulate() { return { data: { files: [] } }; },
});

export const googleGmailSearch = defineTool({
  name: "google.gmail_search",
  version: "1.0.0",
  description: "Search the user's Gmail and return matching messages (subject, from, date, snippet).",
  input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(25).optional() }),
  output: z.object({ messages: z.array(z.object({ id: z.string(), subject: z.string(), from: z.string(), date: z.string(), snippet: z.string() })) }),
  risk: "read", effectClass: "pure", costClass: "free",
  scopes: ["google:read"], agents: ["synthesizer", "data"],
  timeoutMs: 25_000, maxRetries: 0,
  async execute({ query, limit }, ctx) {
    const at = await token(ctx);
    const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${limit ?? 10}`, {
      headers: { authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(15_000) });
    if (!list.ok) throw new ToolFailure("UPSTREAM_ERROR", `Gmail: ${list.status}`, list.status >= 500);
    const ids: string[] = ((await list.json())?.messages ?? []).map((m: any) => m.id);
    const out = [];
    for (const id of ids.slice(0, limit ?? 10)) {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, {
        headers: { authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!r?.ok) continue;
      const m: any = await r.json();
      const h = (name: string) => m?.payload?.headers?.find((x: any) => x.name.toLowerCase() === name)?.value ?? "";
      out.push({ id, subject: h("subject"), from: h("from"), date: h("date"), snippet: String(m.snippet ?? "").slice(0, 160) });
    }
    return { data: { messages: out } };
  },
  async simulate() { return { data: { messages: [] } }; },
});

export const googleGmailSend = defineTool({
  name: "google.gmail_send",
  version: "1.0.0",
  description: "Send an email from the user's Gmail account and return the message id.",
  input: z.object({ to: z.string().email(), subject: z.string().min(1).max(200), body: z.string().min(1).max(20000) }),
  output: z.object({ sent: z.boolean(), id: z.string().nullable() }),
  risk: "write", effectClass: "non_idempotent", costClass: "free",
  scopes: ["google:send"], agents: ["synthesizer"],
  timeoutMs: 25_000, maxRetries: 0,
  async execute({ to, subject, body }, ctx) {
    const at = await token(ctx);
    const raw = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n");
    const encoded = Buffer.from(raw, "utf8").toString("base64url");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: encoded }), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new ToolFailure("UPSTREAM_ERROR", `Gmail send: ${res.status}`, res.status >= 500);
    const j: any = await res.json().catch(() => ({}));
    return { data: { sent: true, id: j.id ?? null } };
  },
  async simulate() { return { data: { sent: false, id: null } }; },
});
