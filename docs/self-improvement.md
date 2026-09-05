---
title: "Self-Improvement"
description: "Let an agent learn operating rules from its own work, and adopt them — in its running instructions and in its source tree."
---

An agent that works in one place for long enough learns things about that
place: the check to run first, the tool that fails without a warm-up, the
thing the team always wants done differently. Self-improvement turns those
lessons into _directives_ — rules the agent follows — on two tracks that
describe the same set:

- **At runtime**, active directives join the agent's instructions at session
  start. No deployment needed.
- **In source**, the same directives render into
  `agent/instructions/learned.md` in the agent's own directory, so the change
  is reviewable, committable, and revertible like any other.

The second track is the point. eve agents are directories on disk, so the
honest form of self-modification is a diff to that directory, not hidden state
nobody can read in a pull request.

## Add self-improvement

Two files. The first observes and proposes:

```ts title="agent/memory/improve.ts"
import { defineMemory } from "eve/memory";
import { selfImprovement } from "eve/self-improvement";

export default defineMemory({
  description: "Learn how to work in this deployment.",
  provider: selfImprovement(),
  scope: "agent",
});
```

The second adopts what was approved:

```ts title="agent/instructions/learned.ts"
export { learnedDirectives as default } from "eve/self-improvement";
```

Directives are agent-wide, not per-caller — they describe the agent, so they
live under a fixed key rather than the slot's resolved scope. The slot's
`scope` still controls _which callers the agent observes_: return `null` for
callers who must not be able to teach it.

## Where a directive comes from

| Signal                         | Produces                                                 |
| ------------------------------ | -------------------------------------------------------- |
| A person correcting the agent  | "From now on, run the migration check before deploying." |
| A failure the agent hit before | "Before calling `sync_invoices`, check its inputs."      |
| The model proposing one        | Whatever it passes to `improve__propose_directive`       |
| A model distiller              | Rules extracted from the turn, when one is configured    |

Every one of them produces a **candidate**. A candidate changes nothing.

## The gate

Promoting learned text into an agent's instructions is the sharpest edge in
this design: it is a path by which conversation content becomes agent
instructions. The gate is explicit, and it defaults closed.

| Mode               | A candidate activates when                       |
| ------------------ | ------------------------------------------------ |
| `review` (default) | A person approves it                             |
| `autonomous`       | Confidence reaches `activationConfidence` (0.85) |

Under `review`, confidence alone never activates anything. Approval runs
through `improve__approve_directive`, which carries `always()` approval, so it
reaches a person through eve's normal
[human-in-the-loop](/docs/human-in-the-loop) path.

Under `autonomous`, confirmation is repetition: an identical restatement
raises a record's confidence, and a contradiction halves it. Directives drawn
from repeated tool failures are written with deterministic text precisely so
they can accumulate that way; a free-form correction cannot, and stays a
candidate.

```ts
provider: selfImprovement({ policy: { mode: "autonomous" } });
```

Choose `autonomous` only for a deployment where every caller is trusted to
change the agent's behavior for every other caller.

An active directive whose confidence collapses below `retirementConfidence`
(0.3) retires on its own. Nothing expires on a timer.

## Reviewing what the agent has learned

The slot contributes five tools alongside the
[learning memory](./learning-memory) ones:

| Tool                          | Does                                          |
| ----------------------------- | --------------------------------------------- |
| `propose_directive`           | Propose a rule; it starts as a candidate      |
| `approve_directive`           | Activate a candidate; requires human approval |
| `retire_directive`            | Stop a directive from applying                |
| `review_directives`           | List directives and their status              |
| `export_learned_instructions` | Render the active set as the file to commit   |

Recall surfaces up to five candidates awaiting review and says plainly that
they are not in effect, so the agent can raise them with the person it is
working with. Active directives never appear in recall — they are already in
the instructions.

## Committing what it learned

`renderAgentPatch()` turns the active set into files for the agent's
directory, and `applyAgentPatch()` writes them:

```ts
import { applyAgentPatch, renderAgentPatch } from "eve/self-improvement";

const written = await applyAgentPatch({
  appRoot: process.cwd(),
  patch: renderAgentPatch(records),
});
```

The write is deliberately narrow: only paths under `agent/`, only Markdown,
and only files small enough to read in a review. Committing the result stays a
human action.

## What a directive can and cannot do

The generated instruction block tells the model, in the block itself, that a
learned note refines its authored instructions and never replaces them — where
a note conflicts with an authored instruction, a tool's approval policy, or a
user's explicit request, the latter wins.

Self-improvement never edits tools, connections, schedules, or the agent
definition. Instructions are the only surface it writes, because they are the
only surface where a wrong entry degrades behavior rather than granting
capability.

## What to read next

- [Learning memory](./learning-memory): the memory layer this is built on.
- [Instructions](./instructions): how dynamic instructions reach the model.
- [Human-in-the-loop](/docs/human-in-the-loop): how approval pauses and resumes a turn.
