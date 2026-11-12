/** Єдиний LLM-клієнт із graceful degradation (§21.3). */
export interface LlmClient {
  readonly name: "deepseek" | "none";
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
      async *stream() { /* без ключа — порожній потік */ },
    };
  }

  return {
    name: "deepseek",
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
