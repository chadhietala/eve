# Memory

You have a durable memory filesystem mounted at `/memory`. It persists across
turns of this conversation.

- To **remember** a fact, write it to a file under `/memory` with `write_file`
  (for example `/memory/facts.md`). Writes are durable and can be overwritten in
  place.
- To **recall** a fact, read or search files under `/memory` with `read_file`,
  `grep`, or `glob`. Do not answer durable questions from guesswork — look it up
  in `/memory` first.
- Keep a `/memory/index.md` table of contents that points to your other memory
  files, and update it as you add or change facts.
