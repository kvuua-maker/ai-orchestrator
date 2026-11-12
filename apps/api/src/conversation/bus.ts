import { EventEmitter } from "node:events";

export type BusEvent =
  | { type: "message.start"; messageId: string; role: "assistant"; meta?: Record<string, unknown> }
  | { type: "message.delta"; messageId: string; text: string }
  | { type: "message.done"; messageId: string; content: string; meta?: Record<string, unknown> }
  | { type: "step"; runId: string; label: string; status: "running" | "done" | "failed"; icon?: string };

/** In-process шина: один процес API, тому EventEmitter достатньо (§10.8). */
class ConversationBus {
  private emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(200); }

  publish(conversationId: string, event: BusEvent): void {
    this.emitter.emit(`conv:${conversationId}`, event);
  }

  subscribe(conversationId: string, handler: (e: BusEvent) => void): () => void {
    const key = `conv:${conversationId}`;
    this.emitter.on(key, handler);
    return () => this.emitter.off(key, handler);
  }
}

export const bus = new ConversationBus();
