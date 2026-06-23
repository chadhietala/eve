import { defineMemory, fsStore, fsTranscriptStore } from "eve/memory";

/**
 * Working-memory layer for the agent-memory fixture: a single durable store
 * mounted at `/mnt/memory/notes`. The framework file tools redirect paths under
 * the mount to this backend, so a fact written in one turn is readable in a
 * later turn of the same thread.
 *
 * It also declares a declarative `dream`: the framework records each session's
 * turns into the session-level transcript log and, on the dream's `cron`
 * cadence, folds a window of them back into the store — steered by
 * `instructions` and the store `description`. The within-thread recall eval does
 * not trigger the dream (it fires on the cron schedule), so this only exercises
 * the declarative surface; it does not change file-tool behavior.
 */
export default defineMemory({
  stores: {
    notes: {
      backend: fsStore("./.eve/memory/notes"),
      description: "Durable user facts and project notes the agent should recall across turns.",
    },
  },
  orientation: [
    "You have a durable memory filesystem mounted at `/mnt/memory/notes`. It",
    "persists across turns of this conversation.",
    "",
    "- To **remember** a fact, write it to a file under `/mnt/memory/notes` with",
    "  `write_file` (for example `/mnt/memory/notes/facts.md`). Writes are durable",
    "  and can be overwritten in place.",
    "- To **recall** a fact, read or search files under `/mnt/memory/notes` with",
    "  `read_file`, `grep`, or `glob`. Do not answer durable questions from",
    "  guesswork — look it up in `/mnt/memory/notes` first.",
    "- Keep a `/mnt/memory/notes/index.md` table of contents that points to your",
    "  other memory files, and update it as you add or change facts.",
  ].join("\n"),
  dream: {
    window: "24h",
    instructions: "Keep durable user facts and project notes; drop one-off chatter.",
    cron: "0 3 * * *",
  },
  transcripts: {
    backend: fsTranscriptStore("./.eve/transcripts"),
    retention: { maxAge: "30d" },
  },
});
