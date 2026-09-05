---
issue: "chadhietala/eve branch claude/eve-agents-desktop-computer-use-r50l3o (repository issues are disabled; tracked on the branch)"
status: proposed
last_updated: "2026-09-05"
---

# Self-improving agents

## Proposal

An eve agent can learn rules about how to work in its deployment and adopt
them, on two tracks that describe the same set:

- **At runtime**, `learnedDirectives()` contributes active directives to the
  agent's instructions at session start. No deployment is needed.
- **In source**, `renderAgentPatch()` writes those directives into
  `agent/instructions/learned.md` — the agent's own directory — so the change
  is reviewable, committable, and revertible like any other.

The second track is the point. eve agents _are_ directories on disk, so the
honest form of self-modification is a diff to that directory, not hidden
runtime state that no one can read in a pull request.

```
turn settles
   │
   ▼
experience()  ──proposes──►  candidate directive  ──gate──►  active directive
   │                                │                            │
   │                          recall: "awaiting review"          ├─► learnedDirectives()
   │                                                             └─► renderAgentPatch()
   └── episodic()/procedural() supply the evidence a proposal is drawn from
```

## The gate

A directive is the one kind of memory that changes how the agent behaves
rather than what it knows, so promoting learned text into system instructions
is the sharpest edge in this design: it is a path by which conversation
content becomes agent instructions. The gate is explicit and defaults closed.

| Mode               | A candidate activates when                       |
| ------------------ | ------------------------------------------------ |
| `review` (default) | A person approves it                             |
| `autonomous`       | Confidence reaches `activationConfidence` (0.85) |

Under `review`, confidence alone never activates anything. Approval runs
through `approve_directive`, which carries `always()` approval, so it goes to
a person on the session's channel through eve's normal human-in-the-loop path.

Under `autonomous`, confirmation is repetition: the learning store raises a
record's confidence by 0.1 on an identical restatement and halves it when a
keyed record is replaced by different text. A directive drawn from a repeated
tool failure is written with deterministic text precisely so it can accumulate
that way; a directive drawn from a person's free-form correction cannot, and
stays a candidate.

An active directive whose confidence falls below `retirementConfidence` (0.3)
retires on the next consolidation pass. Nothing expires on a timer.

## Authoring API

```ts title="agent/memory/improve.ts"
import { defineMemory } from "eve/memory";
import { selfImprovement } from "eve/self-improvement";

export default defineMemory({
  description: "Learn how to work in this deployment.",
  provider: selfImprovement(),
  scope: "agent",
});
```

```ts title="agent/instructions/learned.ts"
export { learnedDirectives as default } from "eve/self-improvement";
```

Directives are agent-wide, not per-caller: they describe the agent, so they
are stored under a fixed key rather than the slot's resolved scope. The slot's
`scope` still controls which callers the agent observes at all — return `null`
for callers that must not be able to teach it.

## Externally observable semantics

- The slot contributes `improve__propose_directive`,
  `improve__approve_directive`, `improve__retire_directive`,
  `improve__review_directives`, and `improve__export_learned_instructions`,
  alongside the learning-memory tools.
- Recall surfaces up to five _candidates awaiting review_ and states that they
  are not in effect. Active directives never appear in recall; they are in the
  instructions.
- `learnedDirectives()` resolves at `session.started` only, so activating a
  directive never changes the rules under a running conversation.
- The rendered instruction block tells the model, in the block itself, that a
  learned note refines authored instructions and never replaces them, and that
  an authored instruction, an approval policy, or a user's explicit request
  wins over a note.
- `applyAgentPatch()` writes only inside `agent/`, only `.md`, and only files
  under 64 KiB. It replaces the generated file rather than appending.

## Boundaries

- Self-improvement never edits tools, connections, schedules, or the agent
  definition. Instructions are the only surface it writes, because they are
  the only surface where a wrong entry degrades behavior instead of granting
  capability.
- It proposes; it does not merge. Turning `agent/instructions/learned.md` into
  a commit stays a human action, and `autonomous` mode is a deployment's
  decision to skip the review step, not the default.
- Learned directives are global to the agent. A multi-tenant deployment that
  must not let one tenant's corrections reach another's sessions should scope
  the observing slot to `null` for untrusted callers, or run separate
  deployments.
