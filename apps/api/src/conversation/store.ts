import type { QueryFn } from "../db/index.js";
import { newId } from "../ids.js";

export interface Conversation { id: string; title: string; created_at: string; updated_at: string }
export interface Message { id: string; role: "user" | "assistant" | "system"; content: string; run_id: string | null; meta: Record<string, unknown>; created_at: string }

export async function createConversation(q: QueryFn, tenantId: string, userId: string, title = "Нова розмова") {
  const id = newId.run().replace("run_", "cnv_");
  const { rows } = await q<Conversation>(
    `INSERT INTO conversations (id, tenant_id, user_id, title) VALUES ($1,$2,$3,$4) RETURNING id, title, created_at, updated_at`,
    [id, tenantId, userId, title.slice(0, 80)]);
  return rows[0]!;
}

export async function listConversations(q: QueryFn, limit = 30) {
  const { rows } = await q<any>(
    `SELECT c.id, c.title, c.updated_at,
            (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id) AS messages
     FROM conversations c ORDER BY c.updated_at DESC LIMIT $1`, [limit]);
  return rows;
}

export async function getConversation(q: QueryFn, id: string) {
  const { rows } = await q<Conversation>("SELECT id, title, created_at, updated_at FROM conversations WHERE id=$1", [id]);
  return rows[0] ?? null;
}

export async function addMessage(
  q: QueryFn,
  input: { tenantId: string; conversationId: string; role: Message["role"]; content: string; runId?: string | null; meta?: Record<string, unknown> },
): Promise<Message> {
  const id = newId.run().replace("run_", "msg_");
  const { rows } = await q<Message>(
    `INSERT INTO messages (id, tenant_id, conversation_id, role, content, run_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING id, role, content, run_id, meta, created_at`,
    [id, input.tenantId, input.conversationId, input.role, input.content, input.runId ?? null, JSON.stringify(input.meta ?? {})]);
  await q("UPDATE conversations SET updated_at=now() WHERE id=$1", [input.conversationId]);
  return rows[0]!;
}

export async function getHistory(q: QueryFn, conversationId: string, limit = 12): Promise<Message[]> {
  const { rows } = await q<Message>(
    `SELECT id, role, content, run_id, meta, created_at FROM messages
     WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT $2`, [conversationId, limit]);
  return rows.reverse();
}

export async function setTitleIfDefault(q: QueryFn, conversationId: string, firstUserText: string) {
  await q(`UPDATE conversations SET title=$2 WHERE id=$1 AND title='Нова розмова'`,
    [conversationId, firstUserText.slice(0, 60)]);
}
