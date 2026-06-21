import { defineMemory, fsStore } from "eve/memory";

/**
 * Working-memory layer for the agent-memory fixture: a single durable store
 * mounted at `/mnt/memory/notes`. The framework file tools redirect paths under
 * the mount to this backend, so a fact written in one turn is readable in a
 * later turn of the same thread.
 */
export default defineMemory({
  stores: {
    notes: { backend: fsStore("./.eve/memory/notes") },
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
});
