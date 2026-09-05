import { factKey, sentences, type MemoryDistiller } from "#public/memory/learning/distiller.js";
import type { MemoryRecord, MemoryRecordInput } from "#public/memory/learning/record.js";
import { tokenize } from "#public/memory/learning/text.js";
import { formatExchange, type Exchange } from "#public/memory/learning/transcript.js";

export interface MemoryArchitectureContext {
  readonly distiller: MemoryDistiller;
  /** The request/response pair that just settled. */
  readonly exchange: Exchange;
  readonly now: number;
  /** The slot's description, passed to a distiller as guidance. */
  readonly purpose: string;
  /** Everything currently stored for this scope. */
  readonly records: readonly MemoryRecord[];
  readonly signal: AbortSignal;
  /** Monotonic turn number within the session. */
  readonly turnSequence: number;
}

/**
 * One way of forming memory from experience.
 *
 * Architectures are additive: an agent can keep a raw episodic trace, a
 * deduplicated set of facts, and a library of procedures at the same time,
 * because they answer different questions. Retrieval ranks across all of
 * them, so adding an architecture widens what can be recalled without
 * changing how recall works.
 */
export interface MemoryArchitecture {
  readonly name: string;
  capture(context: MemoryArchitectureContext): Promise<readonly MemoryRecordInput[]>;
}

// ---------------------------------------------------------------------------
// Episodic
// ---------------------------------------------------------------------------

export interface EpisodicOptions {
  /** Maximum characters in one episode record. Defaults to 320. */
  readonly maxCharacters?: number;
}

/**
 * An append-only trace of what happened, one record per turn.
 *
 * Episodes are the substrate the other architectures are derived from, and
 * the only memory that can answer "what did we do about this last time".
 */
export function episodic(options: EpisodicOptions = {}): MemoryArchitecture {
  const maxCharacters = options.maxCharacters ?? 320;

  return {
    name: "episodic",
    async capture({ exchange, now }) {
      if (exchange.userText.length === 0 && exchange.assistantText.length === 0) return [];

      const failures = exchange.toolCalls.filter((call) => call.failed);
      const parts = [`Asked: ${firstSentence(exchange.userText)}`];
      if (exchange.toolCalls.length > 0) {
        parts.push(`Used: ${[...new Set(exchange.toolCalls.map((call) => call.name))].join(", ")}`);
      }
      if (exchange.assistantText.length > 0) {
        parts.push(`Result: ${firstSentence(exchange.assistantText)}`);
      }
      if (failures.length > 0) {
        parts.push(`Failed: ${[...new Set(failures.map((call) => call.name))].join(", ")}`);
      }

      return [
        {
          confidence: 0.9,
          // A turn that hit a failure is the one worth remembering.
          importance: failures.length > 0 ? 0.7 : 0.4,
          kind: "episode",
          source: `turn:${now}`,
          text: parts.join(" · ").slice(0, maxCharacters),
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Semantic
// ---------------------------------------------------------------------------

/**
 * Deduplicated standing knowledge: preferences, constraints, and facts, each
 * keyed so a later statement replaces the earlier one rather than
 * contradicting it in context.
 */
export function semantic(): MemoryArchitecture {
  return {
    name: "semantic",
    async capture({ distiller, exchange, purpose, signal }) {
      const text = formatExchange(exchange);
      if (text.length === 0) return [];
      const records = await distiller.distill({ kind: "fact", purpose, signal, text });
      return records.map((record) =>
        record.key === undefined ? { ...record, key: factKey(record.text) } : record,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Procedural
// ---------------------------------------------------------------------------

export interface ProceduralOptions {
  /** Minimum tool calls before a turn counts as a procedure. Defaults to 2. */
  readonly minimumSteps?: number;
}

/**
 * How work gets done: the ordered tool sequence that made a kind of task
 * succeed, and the step that made it fail.
 *
 * This is the memory that changes behavior rather than context — an agent
 * that recalls the sequence stops rediscovering it.
 */
export function procedural(options: ProceduralOptions = {}): MemoryArchitecture {
  const minimumSteps = options.minimumSteps ?? 2;

  return {
    name: "procedural",
    async capture({ exchange, now }) {
      if (exchange.toolCalls.length < minimumSteps) return [];
      const task = factKey(exchange.userText);
      if (task.length === 0) return [];

      const records: MemoryRecordInput[] = [];
      const failed = exchange.toolCalls.filter((call) => call.failed);
      const succeeded = exchange.toolCalls.filter((call) => !call.failed);

      if (succeeded.length >= minimumSteps) {
        records.push({
          confidence: 0.7,
          importance: 0.75,
          key: `procedure:${task}`,
          kind: "procedure",
          source: `turn:${now}`,
          text: `To handle "${firstSentence(exchange.userText)}", these steps worked: ${succeeded
            .map((call) => call.name)
            .join(" → ")}.`,
        });
      }
      for (const call of new Set(failed.map((entry) => entry.name))) {
        records.push({
          confidence: 0.6,
          importance: 0.65,
          key: `pitfall:${task}:${call}`,
          kind: "procedure",
          source: `turn:${now}`,
          text: `When handling "${firstSentence(exchange.userText)}", ${call} failed. Check its inputs or use another route first.`,
        });
      }
      return records;
    },
  };
}

// ---------------------------------------------------------------------------
// Reflective
// ---------------------------------------------------------------------------

export interface ReflectiveOptions {
  /** Turns between reflections. Defaults to 5. */
  readonly everyTurns?: number;
  /** Episodes a theme must appear in before it becomes an insight. Defaults to 3. */
  readonly minimumSupport?: number;
  /** Recent episodes considered. Defaults to 20. */
  readonly window?: number;
}

/**
 * Periodic consolidation: what keeps happening, stated once.
 *
 * Episodes accumulate faster than they stay useful. Reflection reads the
 * recent trace and writes back the pattern, so the store gains a claim that
 * outranks the twenty episodes that produced it. With a model-backed
 * distiller the insight is written by the model; without one, recurring
 * themes are detected by frequency, which costs nothing and still catches the
 * repetition that matters.
 */
export function reflective(options: ReflectiveOptions = {}): MemoryArchitecture {
  const everyTurns = options.everyTurns ?? 5;
  const minimumSupport = options.minimumSupport ?? 3;
  const window = options.window ?? 20;

  return {
    name: "reflective",
    async capture({ distiller, now, purpose, records, signal, turnSequence }) {
      if (turnSequence % everyTurns !== 0) return [];

      const episodes = records
        .filter((record) => record.kind === "episode")
        .toSorted((left, right) => right.createdAt - left.createdAt)
        .slice(0, window);
      if (episodes.length < minimumSupport) return [];

      const distilled = await distiller.distill({
        kind: "insight",
        purpose,
        signal,
        text: episodes.map((episode) => `- ${episode.text}`).join("\n"),
      });
      if (distilled.length > 0) return distilled;

      return recurringThemes(episodes, minimumSupport).map((theme) => ({
        confidence: 0.5 + Math.min(0.3, theme.support / 20),
        importance: 0.6,
        key: `insight:${theme.term}`,
        kind: "insight" as const,
        source: `reflection:${now}`,
        text: `"${theme.term}" recurs across ${theme.support} recent turns. Most recently: ${theme.example}`,
      }));
    },
  };
}

const EPISODE_LABEL_PATTERN = /\b(?:asked|used|result|failed):/gi;

interface Theme {
  readonly example: string;
  readonly support: number;
  readonly term: string;
}

function recurringThemes(
  episodes: readonly MemoryRecord[],
  minimumSupport: number,
): readonly Theme[] {
  const support = new Map<string, { count: number; example: string }>();
  for (const episode of episodes) {
    // The episode template's own labels appear in every episode, so they would
    // otherwise outrank every real theme.
    const text = episode.text.replaceAll(EPISODE_LABEL_PATTERN, " ");
    for (const term of new Set(tokenize(text))) {
      const entry = support.get(term);
      if (entry === undefined) support.set(term, { count: 1, example: episode.text });
      else entry.count += 1;
    }
  }

  return [...support.entries()]
    .filter(([, entry]) => entry.count >= minimumSupport)
    .toSorted(([, left], [, right]) => right.count - left.count)
    .slice(0, 3)
    .map(([term, entry]) => ({ example: entry.example, support: entry.count, term }));
}

function firstSentence(text: string): string {
  return sentences(text)[0]?.slice(0, 200) ?? text.slice(0, 200);
}
