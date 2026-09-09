---
issue: "TBD — replace with the tracking issue URL before review"
status: proposed
last_updated: "2026-09-09"
---

# Log-native agent runtime

## Summary

A prototype that tests one claim: an agent is a fold over an append-only log
with a visibility mask, and nothing else. No workflow engine, no parallel state
structure, no separate telemetry pipeline.

The prototype is built **outside eve**, as a standalone repository, so it can
delete abstractions eve currently depends on without breaking anything. It uses
Postgres for durability and builds its own single-writer actor (the
durable-object analog) on top. If the thesis holds, the code migrates back into
eve behind `execution/` and `harness/`; if it does not, we have a cheap,
falsified answer.

Throughout, **the log** is the single append-only sequence of entries that is
simultaneously the agent's state, its telemetry, its audit record, and its
training corpus. It is called the log, not the trace and not the event stream,
because the whole point is that those are the same object.

## Thesis

Four claims, each of which the prototype must make falsifiable:

1. **The log is the program state.** Agent state is `fold(visible(log))`. There
   is no `history: ModelMessage[]` maintained in parallel — the message array
   sent to a provider is a *projection*, recomputable at any offset.
2. **Visibility is the computation.** Compaction, subagent isolation, skill
   loading, memory, retrieval, tool-result truncation, and approval gating are
   one mechanism — a projector over the log — not seven bespoke subsystems.
3. **Telemetry is a projection, not an emission.** Spans, activity feeds, and
   training exports are derived from the same entries that drove the model, so
   they cannot disagree with what actually happened.
4. **Time travel is fork + replay.** Branch at any offset, substitute an oracle
   entry, play forward — with effects quarantined by default.

Claim 2 is the load-bearing one. Claims 1, 3, and 4 are properties that other
event-sourced systems also have; claim 2 is the part that makes this a
different computational model rather than a storage refactor.

## Non-goals

- **Not production.** No multi-region, no authentication, no real channel
  adapters beyond a stub, no horizontal scale story beyond one supervisor per
  log.
- **Not a fork of eve.** The prototype shares no code with eve and imports
  nothing from it. It may borrow entry-type *names* where eve's vocabulary is
  already good.
- **No custom storage engine.** Postgres and nothing else durable. Building a
  log store is a solved problem and not what is being tested.
- **No new agent capabilities.** The prototype should be *less* capable than
  eve. It must only be capable enough that the seven visibility rules are real.

## Worked example

The concrete artifact. A two-turn session with a tool call, an in-band
compaction, and a counterfactual fork. `prov` is provenance.

**Log A**

```
seq  prov     actor         type               payload (abbreviated)
0    oracle   user          user.message       "what's the weather in Oslo?"
1    derived  kernel        turn.started       { turnId: t1 }
2    derived  kernel        model.request      { system, messages: [u0], tools: [weather] }
3    oracle   model         model.completion   { toolCalls: [{ id: c1, name: weather,
                                                  args: { city: "Oslo" } }], usage }
4    derived  kernel        tool.call          { callId: c1, frontier: f1, parents: [e3] }
5    oracle   tool:weather  tool.result        { callId: c1, ok: true, data: { tempC: 4 },
                                                  parents: [e4] }
6    derived  kernel        model.request      { ..., messages: [u0, a3, t5] }
7    oracle   model         model.completion   { text: "It's 4°C in Oslo." }
8    derived  kernel        turn.settled       { turnId: t1 }

9    oracle   user          user.message       "and Bergen?"
10   derived  kernel        turn.started       { turnId: t2 }
...  (same shape: request, completion, tool.call, tool.result, request, completion)
16   derived  kernel        turn.settled       { turnId: t2 }

17   derived  kernel        model.request      { system: <compaction prompt>, messages: [0..16] }
18   oracle   model         model.completion   { text: "User asked about weather in Oslo (4°C)
                                                  and Bergen (7°C)." }
19   derived  kernel        visibility.rule    { kind: "compaction", stage: "select",
                                                  hide: [0, 16], reveal: e18 }
```

Three things to notice:

- Entry 19 does not delete anything. Entries 0–16 are still present and still
  readable by every projection except the prompt. The training exporter still
  sees the original four `(model.request, model.completion)` pairs; the trace
  viewer still shows the full turn tree. Only the *prompt* projection is
  narrowed.
- The compaction summary was produced by an ordinary model call (17–18) that
  appears in the log like any other. Compaction is not a privileged operation.
- Entry 2 stores the **materialized** request, not a recipe for one. Replaying
  the log with a newer interpreter cannot silently reconstruct a different
  prompt than the one actually sent.

**Log B — a counterfactual fork of A at seq 5**

```
log B: { parentLogId: A, forkSeq: 5, worldPolicy: { model: "live",
         tools: "replay", deliver: "quarantine" } }

seq  prov     actor         type               payload
5    oracle   tool:weather  tool.result        { callId: c1, ok: true,
                                                  data: { tempC: -11 } }   ← substituted
6    derived  kernel        model.request      { ..., messages: [u0, a3, t5'] }
7    oracle   model         model.completion   { text: "It's -11°C in Oslo — dress warmly." }
```

Entries 0–4 are never copied; B reads them through its parent pointer. The
prompt at B/6 differs from A/6 in exactly one message part. This is the eval
story: fork a real production session at the step where it went wrong, change
one oracle, play forward.

## Architecture

Six layers, each independently testable. Dependencies point downward only.

```
  cli/            inspect · replay · fork · diff · export
  projections/    prompt · activity · otlp · training
  runtime/        supervisor (leases, oracles, recovery) · world (live/record/replay)
  core/           kernel (pure) · projectors · log view · entry schema
  store/          append (CAS + fencing) · fork read · timers · payloads · leases
  postgres
```

The **kernel** is pure and knows nothing about Postgres, models, or tools. The
**supervisor** is the only component that performs I/O. The **projections** are
pure folds. This split is what makes claim 1 checkable: if any state escapes
the log, it has to live somewhere, and there is only one place it could hide.

## Entry model

### Schema

```ts
interface Entry {
  readonly logId: string;         // ULID of the log (branch)
  readonly seq: number;           // dense, 0-based, per log
  readonly id: string;            // ULID, globally unique across logs
  readonly ts: string;            // wall clock at append — metadata, never causal
  readonly provenance: "oracle" | "derived";
  readonly actor: string;         // "kernel" | "user" | "model" | "tool:<name>" | "supervisor"
  readonly type: string;
  readonly causal: {
    readonly parents: readonly string[];   // entry ids this depends on
    readonly frontier?: string;            // concurrency-group id
  };
  readonly payload: PayloadRef;
  readonly meta: {
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId?: string;
    readonly durationNs?: number;
    readonly tags?: Readonly<Record<string, string | number | boolean>>;
  };
  readonly interpreterVersion?: string;    // required on derived entries
}

type PayloadRef =
  | { readonly kind: "inline"; readonly value: Json }
  | { readonly kind: "keyed"; readonly keyId: string; readonly ciphertext: string }
  | { readonly kind: "external"; readonly uri: string; readonly sha256: string;
      readonly bytes: number };
```

Three decisions embedded here, each of which is expensive to retrofit:

- **`provenance`** — the oracle/derived bit. On a fork, oracle entries are
  exactly the set that must be either re-solicited or replayed from record. A
  derived entry is always recomputable and never needs a policy.
- **`payload` indirection** — payloads are addressed, not embedded. This is
  what makes erasure possible against an immutable substrate: a `keyed` payload
  is encrypted with a per-subject key, and deleting the key destroys the content
  while leaving the entry (and therefore the fold, the seq numbering, and every
  causal link) intact. Crypto-shredding cannot be added later without rewriting
  every log.
- **`meta` carries span identity** — spans are not a second emission, they are
  a rendering of `meta`. See *Projections*.

### Entry types

**Oracle** — externally caused, not recomputable by the kernel:

| type | appended by | notes |
| --- | --- | --- |
| `user.message` | channel/CLI | the bootstrap entry; a log always starts with one |
| `signal.received` | channel/webhook/cron | non-user external input |
| `model.completion` | supervisor | text, reasoning, tool calls, usage, finish reason |
| `tool.result` | supervisor | success or typed failure |
| `approval.decision` | channel | resolves an approval gate |
| `input.response` | channel | resolves a request-input |
| `timer.fired` | timer service | see *Timers* |
| `clock.read` | supervisor | a materialized `Date.now()` |
| `random.draw` | supervisor | a materialized seed |
| `error.raised` | supervisor | externally originated failure (provider 5xx, timeout) |

**Derived** — kernel-appended, recomputable:

| type | notes |
| --- | --- |
| `model.request` | the **materialized** provider request |
| `tool.call` | the intent to call a tool |
| `visibility.rule` | installs/updates/removes a projector — see below |
| `timer.set` | paired with a `timers` row |
| `turn.started` / `turn.settled` | turn boundaries |
| `subagent.spawned` | carries the child `logId` |
| `fork.created` | written to the child at seq 0 metadata |
| `delivery.suppressed` | an outbound effect blocked by quarantine |

A guard test asserts the two sets are disjoint and that no `oracle` entry is
ever written by the kernel.

## Causality and the frontier

The log is totally ordered by append. Causality is a partial order. Conflating
them is the bug that makes replay diverge from the live run.

When the kernel emits `call-tools` with three calls, it appends three
`tool.call` entries sharing a `frontier` id, each with
`parents: [modelCompletionId]`. Results arrive out of order and are appended in
arrival order, each with `parents: [itsToolCallId]`.

Two invariants follow:

- **Frontier completeness.** The kernel does not advance past a frontier until
  every member has a `tool.result` or an `error.raised`. Partially-settled
  frontiers are the parked state.
- **Order-stable rendering.** The prompt projection renders tool results in
  `tool.call` order, never in append order. Without this, a replayed log
  produces a different prompt than the live run — silently, and only under
  concurrency — and provider prompt caching thrashes on every fork.

This is a testable property, not a convention: a fuzz test shuffles result
arrival order and asserts the rendered prompt is byte-identical.

## Visibility and projectors

The core of claim 2.

```ts
type Stage = "select" | "transform" | "render";

interface VisibilityRule {
  readonly id: string;
  readonly kind: string;      // dispatch key into the registry
  readonly stage: Stage;
  readonly priority: number;  // ties broken by installing entry's seq
  readonly params: Json;
}

type Projector = (view: LogView, params: Json, ctx: ProjectorContext) => LogView;
```

Rules are installed by `visibility.rule` entries, so **the set of active
projectors at any offset is itself a fold**:

```ts
projectors(n) = fold(entries[0..n].filter(e => e.type === "visibility.rule"))
prompt(n)     = render(applyStages(projectors(n), entries[0..n]))
```

Stages run in order: `select` decides which entries participate, `transform`
rewrites payloads, `render` emits provider messages. Within a stage, rules run
by `(priority, installing seq)`.

The seven rules the prototype must implement, chosen because each is a distinct
subsystem in eve today:

| rule | stage | what it replaces |
| --- | --- | --- |
| `identity` | select | baseline / control |
| `compaction` | select | destructive history rewrite |
| `subagent-scope` | select | subagent context isolation |
| `skill-gate` | select | progressive skill disclosure |
| `truncate-tool-result` | transform | ad-hoc output clamping |
| `memory-span` | select | cross-session memory (pulls entries from other logs) |
| `retrieval` | select | RAG (dynamic predicate; stub embedder is fine) |

**The falsifiable form of claim 2:** the kernel contains zero branches on
`rule.kind`. A guard test greps the kernel for the string and fails on a hit.
If a rule cannot be expressed without kernel support, the claim is weakened and
we say so explicitly in the writeup rather than adding a special case.

`memory-span` is the interesting one — it reaches across logs, which means
`LogView` must be able to contain entries from more than one `logId`. Design
for that from the start; it is the difference between a projector interface
that generalizes and one that only handles the easy cases.

## The kernel

```ts
interface KernelConfig {
  readonly system: string;
  readonly tools: readonly ToolSpec[];
  readonly limits: { readonly maxSteps: number; readonly maxTokens: number };
  readonly interpreterVersion: string;
}

type Intent =
  | { kind: "call-model"; request: ModelRequest; idempotencyKey: string }
  | { kind: "call-tools"; calls: readonly ToolCall[]; frontier: string }
  | { kind: "install-rule"; rule: VisibilityRule }
  | { kind: "set-timer"; fireAt: string; onFire: EntryDraft }
  | { kind: "spawn-subagent"; seed: SubagentSeed }
  | { kind: "await"; oracleIds: readonly string[] }
  | { kind: "settle"; output: unknown; isError: boolean };

function step(view: LogView, config: KernelConfig): Intent;
```

**Purity contract.** No `Date.now`, no `Math.random`, no `process.env`, no I/O,
no ambient state. Time and randomness enter as `clock.read` and `random.draw`
oracle entries. Enforced mechanically: the kernel package is compiled with a
lint rule banning those globals, and a test runs `step` twice on the same view
asserting deep equality of the intent.

`step` is total — every reachable view yields an intent — and the transition
function is small enough to read in one sitting. If it is not, the model is
wrong.

## The store

### Postgres schema

```sql
CREATE TABLE logs (
  id                  TEXT PRIMARY KEY,
  parent_log_id       TEXT REFERENCES logs(id),
  fork_seq            INTEGER,
  interpreter_version TEXT NOT NULL,
  world_policy        JSONB NOT NULL,
  status              TEXT NOT NULL,          -- running | parked | settled | failed
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((parent_log_id IS NULL) = (fork_seq IS NULL))
);

CREATE TABLE entries (
  log_id      TEXT NOT NULL REFERENCES logs(id),
  seq         INTEGER NOT NULL,
  id          TEXT NOT NULL UNIQUE,
  ts          TIMESTAMPTZ NOT NULL,
  provenance  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  type        TEXT NOT NULL,
  causal      JSONB NOT NULL,
  payload_ref JSONB NOT NULL,
  meta        JSONB NOT NULL,
  interpreter_version TEXT,
  PRIMARY KEY (log_id, seq)
);
CREATE INDEX ON entries (log_id, type);
CREATE INDEX ON entries ((meta->>'traceId'));

CREATE TABLE payloads (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,       -- inline | keyed | external
  inline     JSONB,
  key_id     TEXT REFERENCES shred_keys(id),
  ciphertext BYTEA,
  uri        TEXT,
  sha256     TEXT,
  bytes      BIGINT
);

CREATE TABLE shred_keys (
  id         TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  material   BYTEA,               -- NULL once shredded
  deleted_at TIMESTAMPTZ
);

CREATE TABLE leases (
  log_id     TEXT PRIMARY KEY REFERENCES logs(id),
  holder     TEXT NOT NULL,
  token      BIGINT NOT NULL,     -- fencing token, monotonic per log
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE oracles (
  id                TEXT PRIMARY KEY,
  log_id            TEXT NOT NULL REFERENCES logs(id),
  request_seq       INTEGER NOT NULL,
  idempotency_key   TEXT NOT NULL,
  status            TEXT NOT NULL,   -- pending | settled | abandoned
  response_entry_id TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (log_id, idempotency_key)
);

CREATE TABLE timers (
  id           TEXT PRIMARY KEY,
  log_id       TEXT NOT NULL REFERENCES logs(id),
  fire_at      TIMESTAMPTZ NOT NULL,
  entry_draft  JSONB NOT NULL,
  claimed_by   TEXT,
  claimed_at   TIMESTAMPTZ,
  fired_at     TIMESTAMPTZ
);
CREATE INDEX ON timers (fire_at) WHERE fired_at IS NULL;

CREATE TABLE snapshots (            -- pure cache; safe to TRUNCATE at any time
  log_id TEXT NOT NULL, seq INTEGER NOT NULL, state JSONB NOT NULL,
  PRIMARY KEY (log_id, seq)
);

CREATE TABLE cursors (              -- per-projection read positions
  log_id TEXT NOT NULL, name TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (log_id, name)
);
```

### Append

Optimistic concurrency on `(log_id, expected_seq)` — the primary key does the
work. `append(logId, expectedSeq, entries, fencingToken)`:

1. `SELECT token FROM leases WHERE log_id = $1 FOR UPDATE`; reject if
   `token <> fencingToken` (stale writer).
2. Insert all entries in one statement; a PK collision means another writer won
   the race → return `Conflict(actualSeq)` and let the caller re-read and retry.
3. Return the new head.

Batch appends are atomic — a `model.request` and the `oracles` row that tracks
it commit together, or neither does.

### Fork reads

Copy-on-write via recursive CTE:

```sql
WITH RECURSIVE chain AS (
  SELECT id, parent_log_id, fork_seq, 0 AS depth FROM logs WHERE id = $1
  UNION ALL
  SELECT l.id, l.parent_log_id, l.fork_seq, chain.depth + 1
  FROM logs l JOIN chain ON l.id = chain.parent_log_id
  WHERE chain.depth < 32
)
SELECT e.* FROM entries e JOIN chain c ON e.log_id = c.id
WHERE c.depth = 0 OR e.seq < c.fork_seq
ORDER BY ...
```

Ordering across the chain is by `(depth DESC, seq ASC)`. Fork depth is capped
at 32; deeper forks must be materialized (copy the resolved prefix into the
child). Measure the crossover point in M8 rather than guessing it.

## The supervisor

The durable-object analog, built by hand. One supervisor owns one log at a
time. This is the only component that performs I/O.

**Lease acquisition.** `INSERT ... ON CONFLICT DO UPDATE` on `leases` where
`expires_at < now()`, incrementing `token`. The winner holds the log for a lease
period (start at 30s) and renews on a heartbeat. Every append carries the token;
a stale supervisor's appends are rejected, so a partitioned or paused process
cannot corrupt the log when it resumes.

**Main loop.**

```
loop {
  view   = read(logId)                      // fork-resolved, snapshot-accelerated
  intent = kernel.step(view, config)        // pure
  match intent {
    call-model | call-tools | set-timer | spawn-subagent =>
      append(derived entries + oracles rows)   // atomic
      dispatch via world                        // may be slow
      append(oracle result entry, settle oracles row)
    install-rule => append(visibility.rule entry)
    await        => park; release lease; return
    settle       => append(turn.settled); mark log settled; return
  }
}
```

**Crash recovery.** No special path. On lease acquisition the supervisor reads
the log and calls `step`. If a `model.request` was appended but its
`model.completion` never arrived, the view naturally yields the same
`call-model` intent again — and the `oracles` row's `idempotency_key`
deduplicates the effect. Recovery is not a subsystem; it is the ordinary loop
starting from a durable state.

This is the strongest structural argument for the model, and M3 exists
specifically to demonstrate it: kill the process at every step boundary and
assert exactly-once effects.

**Idempotency keys.** Derived as
`hash(logId, requestSeq, interpreterVersion, canonicalRequestBody)`. Tool
adapters that support idempotency receive it; those that do not are marked
`at-least-once` in their spec and the log records the retry honestly as a
second `tool.call`.

## Timers

The one irreducible non-log primitive: something must fire at wall-clock T.

`set-timer` writes a `timers` row in the same transaction as the `timer.set`
entry. A timer service polls `SELECT ... WHERE fire_at <= now() AND fired_at IS
NULL ORDER BY fire_at LIMIT n FOR UPDATE SKIP LOCKED`, claims the row, appends
`timer.fired` to the log, and wakes the supervisor (Postgres `LISTEN/NOTIFY`).

Deliberately dumb. Polling at 1s resolution is fine for a prototype and keeps
the durability story inspectable. What matters is proving that durable sleep,
session timeouts, and scheduled wakeups all reduce to one oracle entry type.

## The world

Effect quarantine — the problem no amount of clever log encoding solves.

```ts
interface World {
  callModel(req: ModelRequest, key: string): Promise<ModelCompletion>;
  callTool(call: ToolCall, key: string): Promise<ToolResult>;
  now(): Promise<string>;
  random(): Promise<string>;
  deliver(msg: OutboundMessage): Promise<DeliveryOutcome>;
}
```

Every effect goes through it. Three modes, selectable **per capability** in
`logs.world_policy`:

- **`live`** — really call it, append the result as an oracle entry. Normal
  operation is `live` everywhere; recording is not a separate mode because
  appending the result *is* the recording.
- **`replay`** — do not call. Read the corresponding oracle entry from the
  parent chain at the matching offset and return it. If the request does not
  match the recorded one (the fork diverged), apply `onDivergence`:
  `error` (default), `fallthrough` (go live), or `stub`.
- **`quarantine`** — do not call, append `delivery.suppressed` with the payload
  that *would* have been sent, and return a synthetic success.

Default policy for a fork: `{ model: "live", tools: "replay", deliver:
"quarantine" }`. Going live on `deliver` requires an explicit flag on the fork
command and prints what will be contacted. A forked agent must not be able to
message a real person by accident — that is the acceptance criterion, and M7
tests it by asserting the stub channel receives zero calls during a fork suite.

## Projections

Every read model is a pure fold with a named cursor in `cursors`. Dropping a
cursor rebuilds the model from scratch. This is the "one lineage" claim made
operational.

- **`prompt`** — `LogView → ModelRequest`. The only projection in the execution
  path. Everything else is observation.
- **`activity`** — `Entry → ActivityEvent[]`, a UI-facing feed. Mirrors eve's
  existing `execution/activity-events.ts`, which is already exactly this shape
  and is the best evidence the pattern generalizes.
- **`otlp`** — `Entry → Span`. `meta.spanId` / `meta.parentSpanId` /
  `meta.durationNs` are already on every entry, so this is a rendering, not an
  instrumentation pass. **Sampling happens here**, at projection time, which
  means an unsampled trace is still fully reconstructable later — strictly more
  information than sample-at-emission.
- **`training`** — emits `(model.request, model.completion)` pairs. Because
  requests are materialized rather than re-derived, these are the exact bytes
  sent, not a reconstruction that a newer interpreter would produce.

Retention and erasure live here too. Telemetry retention is implemented by
pruning *projections and their cursors*, never entries. Subject erasure is
implemented by deleting a `shred_keys` row: the entry survives, the fold
structure survives, the content is gone, and any projection that needs the
plaintext degrades to a tombstone.

## Fork and time travel

```
tracelog fork <logId> --at <seq> [--set <seq>=<file.json>] [--policy <json>]
```

1. Insert a `logs` row with `parent_log_id` and `fork_seq = at`.
2. Optionally append substituted oracle entries at the fork point.
3. Start a supervisor on the child under the fork's world policy.

Constraints worth stating up front:

- Only **oracle** entries may be substituted. Substituting a derived entry is
  rejected — it would make the log inconsistent with its own fold.
- A fork inherits `interpreter_version` from its parent by default.
  `--interpreter latest` is allowed but flagged loudly in the diff output,
  because it changes prompts for reasons unrelated to the substitution.
- Forks are first-class logs. A fork of a fork is ordinary.

`tracelog diff <logA> <logB>` renders the first divergent entry and the prompt
delta at that offset. This is the eval-authoring surface: the answer to "what
would the agent have done if the tool had returned something else" is a command,
not a fixture tree.

## Milestones

Sizes are rough relative weights for one engineer, not commitments.

### M0 — Store and skeleton (S)

Postgres via docker-compose, migrations, `append` with CAS + fencing, fork-
resolving read, payload indirection, ULID generation.

*Accept:* property test — N concurrent appenders against one log produce a dense
`seq` with no gaps, no duplicates, and every rejected append reports the actual
head. Fork read returns the correct interleaving for a 4-deep chain.

### M1 — Kernel and the closed loop (M)

Entry schema, `LogView`, `step`, `prompt` projection, mock model adapter. One
turn: `user.message` → `model.request` → `model.completion` → `turn.settled`.

*Accept:* the runtime holds no mutable state other than `{ logId, seq }`.
`TRUNCATE snapshots` mid-run and the session continues to a correct result.
`step(view) === step(view)` deep-equal under a purity fuzz.

### M2 — Tools, frontiers, partial order (M)

`tool.call` / `tool.result`, parallel calls, frontier completeness,
order-stable rendering.

*Accept:* shuffle-arrival fuzz over 3–8 parallel tool calls yields a
byte-identical rendered prompt across 1000 permutations.

### M3 — Supervisor and durability (L)

Leases, fencing tokens, heartbeats, `oracles` tracking, idempotency keys,
crash recovery through the ordinary loop.

*Accept:* `kill -9` injected at every step boundary across a 40-entry session,
1000 iterations — zero duplicate side effects (asserted by a counting tool
adapter), zero corrupt logs, every run converges to the same terminal state.
Stale-lease appends are rejected 100% of the time.

### M4 — Timers (S)

`timer.set` / `timer.fired`, the polling service, `LISTEN/NOTIFY` wakeups,
durable sleep across a supervisor restart.

*Accept:* an agent sleeps 60s across a full process restart and resumes with
the correct view. Timer claiming is exactly-once under 8 concurrent pollers.

### M5 — Visibility rules (L) — **the thesis milestone**

All seven projectors, the stage/priority composition model, `visibility.rule`
entries, cross-log `LogView` for `memory-span`.

*Accept:* zero occurrences of `rule.kind` branching in the kernel package
(guard test). Compaction is non-destructive: after compacting, the `training`
projection still emits every pre-compaction pair. A subagent's prompt contains
exactly its seed prefix plus its own subtree, asserted entry-by-entry.

### M6 — Projections and one lineage (M)

`activity`, `otlp`, `training` projections; cursors; projection-time sampling;
crypto-shredding.

*Accept:* the span tree, the activity feed, and the prompt lineage agree on the
set of model calls and tool calls for 100 generated sessions (property test).
Dropping every cursor and rebuilding yields identical output. Shredding a key
removes plaintext from all projections while the fold still produces the same
message *count* and structure.

### M7 — Fork, replay, quarantine, inspector (L)

Fork command, world modes, divergence policy, `diff`, `inspect` TUI.

*Accept:* replay of a recorded log reproduces every `model.request` byte-for-
byte. A fork with a substituted tool result differs from its parent in exactly
one message part at the fork offset. The stub channel records zero deliveries
across the entire fork test suite.

### M8 — Measurement and writeup (M)

Benchmarks, LOC comparison, the honest report.

*Accept:* the numbers below exist and the writeup states plainly which of the
four claims survived.

## Falsification suite

Written before the milestones they test. Each maps to a claim.

| # | test | claim | fails if |
| --- | --- | --- | --- |
| F1 | truncate all caches mid-run; run continues correctly | 1 | any state lives outside the log |
| F2 | byte-exact replay of every `model.request` | 1, 4 | interpreter drift or hidden nondeterminism |
| F3 | kernel contains no branch on `rule.kind` | 2 | a rule needs kernel support |
| F4 | compaction preserves the training projection | 2 | compaction is secretly destructive |
| F5 | span tree ≡ activity feed ≡ prompt lineage | 3 | the projections can disagree |
| F6 | fork differs in exactly the substituted part | 4 | fork leaks state or re-derives prompts |
| F7 | `kill -9` fuzz, exactly-once effects | — | the hand-built durability is unsound |
| F8 | shuffle-arrival prompt stability | — | partial order is mishandled |
| F9 | zero real deliveries during fork suite | 4 | quarantine is not airtight |

If F3 fails we report it as a partial result rather than adding a kernel
special case. A weakened claim 2 that is honestly stated is more useful than a
strong claim that was arranged.

## Benchmarks

Numbers that decide whether this is viable, not just elegant:

- **Fold cost per step** at log lengths 10 / 100 / 1k / 10k entries, with and
  without snapshots. Establishes the snapshot interval.
- **Prompt-cache hit rate on forks.** A prefix-stable projection should keep
  provider cache hits across a fork; measure it, because it is a real economic
  argument for the design.
- **Fork read cost by chain depth** 1 / 4 / 16 / 32. Finds the materialization
  crossover.
- **Append throughput and p99 latency** under 1 / 8 / 64 concurrent logs.
- **LOC comparison.** Kernel + projectors + supervisor versus the eve
  subsystems they would replace. eve's `execution/` + `harness/` is currently
  **46,503 lines across 298 non-test files**; the equivalent-semantics subset is
  smaller than that and must be scoped honestly before comparing. An
  order-of-magnitude reduction is the claim worth testing; anything under 2× is
  a negative result for the "leaner core" argument.

## Repository layout

```
tracelog/
  docker-compose.yml
  packages/
    core/          entry.ts log.ts kernel.ts intent.ts projector.ts
                   projectors/{identity,compaction,subagent-scope,skill-gate,
                               truncate-tool-result,memory-span,retrieval}.ts
                   render.ts
    store/         migrations/*.sql append.ts read.ts lease.ts timers.ts
                   payload.ts shred.ts
    runtime/       supervisor.ts world.ts oracles.ts adapters/{model,tool,channel}.ts
    projections/   prompt.ts activity.ts otlp.ts training.ts cursor.ts
    cli/           inspect.ts fork.ts replay.ts diff.ts export.ts
  examples/        weather.ts  research-subagent.ts  long-running-timer.ts
  bench/
  test/            falsification/{f1..f9}.test.ts
```

## Tech choices

- **TypeScript, Node 22, pnpm workspaces.** Matches eve, so code can migrate
  rather than be ported.
- **Postgres 16**, `pg` client, hand-written SQL. No ORM — the schema is the
  design and should be readable as such.
- **Vitest**, plus `fast-check` for the property and fuzz tests.
- **Mock model by default.** The whole suite runs offline and deterministically;
  a real provider is opt-in behind an env var. Determinism is the product here,
  so the default must be deterministic.
- **No workflow engine, no actor framework, no event-sourcing library.**
  Importing one would answer the question by assumption.

## Open questions

1. **Subagents: separate logs with cross-references, or nested regions in one
   log?** Separate logs make quarantine, forking, and lease ownership clean but
   force cross-log `LogView`. Nested regions keep one lineage but make
   concurrency and lease ownership hard. The prototype starts with **separate
   logs plus `memory-span`-style cross-log visibility**, because it also forces
   the projector interface to generalize early — but this is the decision most
   likely to be wrong.
2. **Is `clock.read` per-call or per-step?** Per-call is exact and noisy;
   per-step is compact and slightly lies. Start per-call, measure the noise.
3. **What is the snapshot invalidation rule under forks?** A snapshot at
   `(logId, seq)` is only valid for that log's chain. Cheap to get wrong.
4. **Does `retrieval` belong at `select` or `render`?** As a `select` rule it
   changes the fold input, which is conceptually clean but makes prompt caching
   unstable. Worth testing both.
5. **How does a rule get *uninstalled*?** A `visibility.rule` entry with a
   tombstone marker, or a separate `visibility.rule.removed` type? The former
   keeps one type; the latter is easier to read in a log dump.
6. **Do we need `error.raised` as an oracle type, or is a failed
   `tool.result` enough?** Provider-level failures have no `tool.call` to attach
   to, which argues for keeping it.

## Path back to eve

If the thesis survives, migration is staged and each stage stands alone:

1. Adopt the entry schema as eve's `MessageStreamEvent` v2 — provenance bit,
   payload indirection, causal metadata. Additive, no behavior change.
2. Make `history` a projection. `shared/history-view.ts` is already
   `(messages, state) → messages`; widen it to `(LogView) → messages`.
   This is the single highest-value change and it does not require the rest.
3. Move compaction to a `visibility.rule` entry. Compaction stops being
   destructive.
4. Derive spans from entries; retire the parallel instrumentation pass.
5. Only then consider replacing the workflow engine with the supervisor — and
   only if M8's LOC and durability numbers actually support it.

Stages 1–4 are worth doing even if stage 5 never happens. That is the point of
prototyping outside eve: the expensive, irreversible bet stays optional.
