import { generateText, type LanguageModel } from "ai";

import type { MemoryRecordInput, MemoryRecordKind } from "#public/memory/learning/record.js";

export interface DistillInput {
  /** What the caller wants out: a stable fact, a reusable procedure, or an insight. */
  readonly kind: MemoryRecordKind;
  /** Guidance for the distiller, e.g. what the slot is for. */
  readonly purpose: string;
  readonly signal: AbortSignal;
  /** The material to distill: a transcript, or recent records. */
  readonly text: string;
}

/**
 * Turns raw conversation into candidate records.
 *
 * Distillation is the one part of learning that benefits from a model, and
 * the one part that costs money on every turn — so it is a seam. The default
 * is free and deterministic; an application that wants better extraction
 * passes a model-backed distiller.
 */
export interface MemoryDistiller {
  readonly id: string;
  distill(input: DistillInput): Promise<readonly MemoryRecordInput[]>;
}

const FACT_PATTERNS: readonly { readonly importance: number; readonly pattern: RegExp }[] = [
  { importance: 0.8, pattern: /\b(?:i|we)\s+(?:always|never|usually|prefer|use|want|need)\b/i },
  { importance: 0.75, pattern: /\b(?:my|our)\s+[a-z]+\s+(?:is|are|lives?|runs?|uses?)\b/i },
  { importance: 0.7, pattern: /\b(?:call|address|refer to)\s+(?:me|us)\b/i },
  { importance: 0.65, pattern: /\b(?:don'?t|do not|never)\s+[a-z]+/i },
  { importance: 0.6, pattern: /\b(?:from now on|going forward|in future|next time)\b/i },
  { importance: 0.6, pattern: /\b(?:actually|correction|that'?s wrong|not quite)\b/i },
];

const MAX_SENTENCES = 12;

/**
 * Extracts candidates with patterns rather than a model.
 *
 * It looks for the shapes that carry durable information in a conversation:
 * stated preferences, corrections, and standing constraints. It is
 * conservative by design — a wrong memory is worse than a missing one,
 * because it is recalled into every future turn.
 */
export function heuristicDistiller(): MemoryDistiller {
  return {
    id: "heuristic-v1",
    async distill(input) {
      // Only stable facts have a reliable textual signature. Procedures,
      // insights, and directives need a model, or an architecture that reads
      // structure rather than prose.
      if (input.kind !== "fact") return [];

      const candidates: MemoryRecordInput[] = [];
      for (const sentence of sentences(input.text).slice(0, MAX_SENTENCES)) {
        const match = FACT_PATTERNS.find((entry) => entry.pattern.test(sentence));
        if (match === undefined) continue;
        const text = sentence.replace(/^(?:user|assistant|tools):\s*/i, "").trim();
        if (text.length < 8) continue;
        candidates.push({
          confidence: 0.55,
          importance: match.importance,
          key: factKey(text),
          kind: "fact",
          text,
        });
      }
      return candidates;
    },
  };
}

export interface ModelDistillerOptions {
  /** Maximum records to accept from one distillation. Defaults to 4. */
  readonly maxRecords?: number;
  readonly model: LanguageModel;
}

/**
 * Asks a model for durable records, and accepts only what parses.
 *
 * A distiller runs after a turn has already answered the user, so a failure
 * here must never fail the turn: an unparsable or empty response yields no
 * records and the agent simply learns nothing from that turn.
 */
export function modelDistiller(options: ModelDistillerOptions): MemoryDistiller {
  const maxRecords = options.maxRecords ?? 4;

  return {
    id: "model-v1",
    async distill(input) {
      const result = await generateText({
        abortSignal: input.signal,
        messages: [
          { role: "system", content: systemPrompt(input.kind, input.purpose, maxRecords) },
          { role: "user", content: input.text },
        ],
        model: options.model,
      });

      const parsed = parseRecords(result.text);
      return parsed.slice(0, maxRecords).map((entry) => {
        const record: MemoryRecordInput = {
          confidence: typeof entry.confidence === "number" ? entry.confidence : 0.7,
          importance: typeof entry.importance === "number" ? entry.importance : 0.6,
          kind: input.kind,
          text: String(entry.text),
        };
        return typeof entry.key === "string" && entry.key.length > 0
          ? { ...record, key: entry.key.slice(0, 128) }
          : record;
      });
    },
  };
}

function systemPrompt(kind: MemoryRecordKind, purpose: string, maxRecords: number): string {
  const target = {
    fact: "stable facts, preferences, and constraints that will still be true next week",
    procedure: "reusable procedures: the ordered steps that made this kind of task succeed",
    insight: "higher-level patterns across the material, each supported by more than one example",
    episode: "a one-sentence summary of what happened and how it turned out",
    directive:
      "operating rules the agent should follow next time, each stated as an instruction it can act on",
  }[kind];

  return [
    `Extract at most ${maxRecords} durable memories from the material below.`,
    `Capture ${target}.`,
    `The memory slot is for: ${purpose}`,
    "",
    "Rules:",
    "- Record nothing that is only true for the current task.",
    "- Record no secrets, credentials, or one-time codes.",
    "- Write each memory so it is understandable with no other context.",
    "- Prefer no memory over a doubtful one.",
    "",
    'Respond with JSON only: {"memories":[{"text":"…","key":"short-stable-id","importance":0.0-1.0,"confidence":0.0-1.0}]}',
    'Respond with {"memories":[]} when nothing is durable.',
  ].join("\n");
}

interface ParsedRecord {
  readonly confidence?: unknown;
  readonly importance?: unknown;
  readonly key?: unknown;
  readonly text?: unknown;
}

function parseRecords(text: string): readonly ParsedRecord[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const memories = (parsed as { readonly memories?: unknown }).memories;
  if (!Array.isArray(memories)) return [];
  return memories.filter(
    (entry): entry is ParsedRecord =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ParsedRecord).text === "string" &&
      (entry as { text: string }).text.trim().length > 0,
  );
}

export function sentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * A coarse supersession key: the leading content words of a claim. Two
 * statements about the same subject replace each other instead of
 * accumulating as contradictions.
 */
export function factKey(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 4)
    .join("-");
}
