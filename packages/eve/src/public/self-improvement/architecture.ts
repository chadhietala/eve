import type { MemoryArchitecture } from "#public/memory/learning/architectures.js";
import { factKey, sentences } from "#public/memory/learning/distiller.js";
import type { MemoryRecordInput } from "#public/memory/learning/record.js";
import { formatExchange } from "#public/memory/learning/transcript.js";

/**
 * Sentences that state how the agent should behave next time, rather than a
 * fact about the world. These are the moments an agent can actually learn a
 * rule from: a person correcting it, or telling it what to do differently.
 */
const CORRECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:from now on|going forward|next time|in future|in the future)\b/i,
  /\b(?:always|never)\s+(?:use|check|ask|run|call|start|include|avoid|skip)\b/i,
  /\b(?:don'?t|do not|stop)\s+[a-z]+/i,
  /\b(?:instead of|rather than)\b/i,
  /\b(?:actually|correction|that'?s wrong|not quite|no,)\b/i,
];

export interface ExperienceOptions {
  /** Maximum directive candidates from one turn. Defaults to 2. */
  readonly maxCandidates?: number;
}

/**
 * A memory architecture that proposes operating rules from experience.
 *
 * Two things produce a candidate: a person correcting the agent, and a
 * failure the agent has already hit here before. Both are the same signal —
 * evidence that the agent's current behavior is wrong for this deployment —
 * and both are only ever proposals. Nothing this writes changes behavior
 * until it is activated.
 */
export function experience(options: ExperienceOptions = {}): MemoryArchitecture {
  const maxCandidates = options.maxCandidates ?? 2;

  return {
    name: "experience",
    async capture({ distiller, exchange, purpose, records, signal }) {
      const candidates: MemoryRecordInput[] = [];

      for (const sentence of sentences(exchange.userText)) {
        if (!CORRECTION_PATTERNS.some((pattern) => pattern.test(sentence))) continue;
        if (sentence.length < 12) continue;
        candidates.push({
          confidence: 0.6,
          importance: 0.8,
          key: `directive:${factKey(sentence)}`,
          kind: "directive",
          text: sentence,
        });
      }

      for (const name of new Set(
        exchange.toolCalls.filter((call) => call.failed).map((call) => call.name),
      )) {
        const seenBefore = records.some(
          (record) => record.kind === "procedure" && record.text.includes(`${name} failed`),
        );
        if (!seenBefore) continue;
        candidates.push({
          confidence: 0.6,
          importance: 0.7,
          key: `directive:tool:${name}`,
          kind: "directive",
          // Deterministic text: repetition is what raises a candidate's
          // confidence, and only an identical restatement counts.
          text: `Before calling ${name}, check its inputs against a recent successful call — it has failed in this deployment before.`,
        });
      }

      const distilled = await distiller.distill({
        kind: "directive",
        purpose,
        signal,
        text: formatExchange(exchange),
      });
      candidates.push(
        ...distilled.map((record) =>
          record.key === undefined
            ? { ...record, key: `directive:${factKey(record.text)}` }
            : record,
        ),
      );

      return candidates.slice(0, maxCandidates);
    },
  };
}
