/** Єдиний LLM-клієнт із graceful degradation (§21.3). */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}
export interface ChatToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ChatResult { content: string; toolCalls: ChatToolCall[] }

export interface LlmClient {
  readonly name: "deepseek" | "none";
  /** Стандартний function calling: модель сама вирішує — текст чи інструмент. */
  chat(input: {
    messages: ChatMessage[];
    tools?: any[];
    maxTokens?: number;
    temperature?: number;
    onDelta?: (text: string) => void;
  }): Promise<ChatResult>;
  json<T>(input: { system: string; user: string; maxTokens?: number }): Promise<T | null>;
  /** Потокова відповідь: yield шматків тексту в міру генерації. */
  stream(input: { system: string; user: string; maxTokens?: number }): AsyncGenerator<string>;
}

export function createLlm(opts: { apiKey?: string; baseUrl?: string; model?: string } = {}): LlmClient {
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
  const baseUrl = opts.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = opts.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  if (!apiKey) {
    return {
      name: "none",
      async json() { return null; },
      async chat() { return { content: "", toolCalls: [] }; },
      async *stream() { /* без ключа — порожній потік */ },
    };
  }

  return {
    name: "deepseek",

    /** Стрімінг + tool calls в одному запиті (OpenAI-сумісний протокол DeepSeek). */
    async chat({ messages, tools, maxTokens = 1200, temperature = 0.4, onDelta }: any): Promise<ChatResult> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, temperature, max_tokens: maxTokens, stream: true,
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
          messages,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
      }
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "", content = "";
      const calls = new Map<number, { id: string; name: string; args: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk: any;
          try { chunk = JSON.parse(payload); } catch { continue; }
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) { content += delta.content; onDelta?.(delta.content); }
          for (const tc of delta.tool_calls ?? []) {
            const cur = calls.get(tc.index ?? 0) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(tc.index ?? 0, cur);
          }
        }
      }

      const toolCalls: ChatToolCall[] = [...calls.values()].filter((c) => c.name).map((c) => {
        let args: Record<string, unknown> = {};
        try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = {}; }
        return { id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.name, args };
      });
      return { content, toolCalls };
    },

    async *stream({ system, user, maxTokens = 900 }: { system: string; user: string; maxTokens?: number }) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, temperature: 0.6, max_tokens: maxTokens, stream: true,
          messages: [{ role: "system", content: system }, { role: "user", content: user.slice(0, 6000) }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok || !res.body) return;
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk?.choices?.[0]?.delta?.content;
            if (delta) yield String(delta);
          } catch { /* ігноруємо биті шматки */ }
        }
      }
    },
    async json<T>({ system, user, maxTokens = 700 }: { system: string; user: string; maxTokens?: number }) {
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model, temperature: 0.1, max_tokens: maxTokens, response_format: { type: "json_object" },
            messages: [{ role: "system", content: system }, { role: "user", content: user.slice(0, 6000) }],
          }),
          signal: AbortSignal.timeout(25_000),
        });
        if (!res.ok) return null;
        const body: any = await res.json();
        const content = body?.choices?.[0]?.message?.content;
        return content ? (JSON.parse(content) as T) : null;
      } catch { return null; }
    },
  };
}
