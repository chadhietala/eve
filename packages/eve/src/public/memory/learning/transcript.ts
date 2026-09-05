import type { ModelMessage } from "ai";

/** The most recent request/response pair, flattened for capture. */
export interface Exchange {
  readonly assistantText: string;
  /** Tool calls in the exchange, in order, with whether each returned an error. */
  readonly toolCalls: readonly { readonly failed: boolean; readonly name: string }[];
  readonly userText: string;
}

/** Extracts the plain text of a model message, ignoring non-text parts. */
export function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n").trim();
}

/**
 * Reads the last user turn and everything the assistant did in response.
 *
 * Capture handlers receive the whole settled history, but what an agent
 * learned happened in the last exchange; earlier turns were already captured
 * when they settled.
 */
export function lastExchange(messages: readonly ModelMessage[]): Exchange {
  let lastUserIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") lastUserIndex = index;
  }

  const userText = lastUserIndex === -1 ? "" : messageText(messages[lastUserIndex]!);
  const assistantParts: string[] = [];
  const toolCalls: { failed: boolean; name: string }[] = [];

  for (const message of messages.slice(lastUserIndex + 1)) {
    if (message.role === "assistant") {
      const text = messageText(message);
      if (text.length > 0) assistantParts.push(text);
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "tool-call") toolCalls.push({ failed: false, name: part.toolName });
        }
      }
    }
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const failed = isErrorResult(part.output);
        const existing = toolCalls.findLast((call) => call.name === part.toolName);
        if (existing !== undefined) existing.failed = failed;
      }
    }
  }

  return { assistantText: assistantParts.join("\n").trim(), toolCalls, userText };
}

function isErrorResult(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const type = (output as { readonly type?: unknown }).type;
  return type === "error-text" || type === "error-json";
}

/** Renders an exchange as a compact transcript for a distiller prompt. */
export function formatExchange(exchange: Exchange, maxCharacters = 4_000): string {
  const lines: string[] = [];
  if (exchange.userText.length > 0) lines.push(`User: ${exchange.userText}`);
  if (exchange.toolCalls.length > 0) {
    lines.push(
      `Tools: ${exchange.toolCalls
        .map((call) => `${call.name}${call.failed ? " (failed)" : ""}`)
        .join(", ")}`,
    );
  }
  if (exchange.assistantText.length > 0) lines.push(`Assistant: ${exchange.assistantText}`);
  const text = lines.join("\n");
  return text.length <= maxCharacters ? text : `${text.slice(0, maxCharacters)}…`;
}
