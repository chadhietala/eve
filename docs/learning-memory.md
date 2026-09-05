---
title: "Learning Memory"
description: "A memory provider that learns from every turn: episodic, semantic, procedural, and reflective records, ranked by a measured retrieval strategy."
---

`learningMemory()` is a [memory](./memory) provider that forms memory from the
agent's own experience. Every turn it writes what it observed; every turn it
ranks everything it has stored against what the agent is about to do and
recalls the top slice.

It is built from four seams, and each one can be replaced on its own:

| Seam         | Decides                           | Default                |
| ------------ | --------------------------------- | ---------------------- |
| Architecture | What is worth writing             | All four, together     |
| Retrieval    | What is worth recalling           | `balancedRetrieval()`  |
| Distiller    | How conversation becomes a record | `heuristicDistiller()` |
| Embedding    | How text becomes a vector         | `hashingEmbedding()`   |

Every default is deterministic and needs neither a model nor a network, so the
agent starts learning on its first turn.

## Add a learning slot

```ts title="agent/memory/experience.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { learningMemory } from "eve/memory/learning";

export default defineMemory({
  description: "Learn how this person works and what has worked before.",
  provider: learningMemory(),
  scope: byPrincipal,
});
```

The filename creates the `experience` slot, so the model gets
`experience__remember`, `experience__forget`, and `experience__search`.
Storage uses the same backend resolution as
[`fileMemory()`](./memory#choose-a-file-backend); pass `backend` to choose
one explicitly.

## What it writes

Four architectures run on every settled turn. They are additive, because they
answer different questions:

| Architecture   | Writes                                                     | Answers                                |
| -------------- | ---------------------------------------------------------- | -------------------------------------- |
| `episodic()`   | One record per turn: what was asked, what ran, what failed | "What did we do about this last time?" |
| `semantic()`   | Keyed standing facts and constraints                       | "What is always true for this caller?" |
| `procedural()` | The tool sequence that worked, and the step that failed    | "How is this kind of task done here?"  |
| `reflective()` | Periodic consolidation of the recent episodic trace        | "What keeps happening?"                |

Choose a narrower set when a slot has one job:

```ts
provider: learningMemory({ architectures: [semantic()] });
```

A record carries an importance and a confidence. A record with a `key`
replaces the record holding that key, so a later statement supersedes an
earlier one instead of contradicting it in context. An exact restatement
reinforces the existing record rather than duplicating it.

## What it recalls

Recall returns one keyed message, so each turn's recall replaces the previous
one rather than accumulating. The message leads with up to two _pinned_
records — the highest standing value in the store — and then the best matches
for this turn. Pinning exists because a standing fact such as the caller's
name has no term overlap with most turns and query relevance alone would bury
it:

```ts
provider: learningMemory({ pinned: 0, topK: 12 });
```

Records recalled during a turn have their access count incremented when the
turn settles, which feeds both ranking and eviction. The store is bounded:
512 records and 512 KiB by default, evicted by standing value — importance,
confidence, proven usefulness, and freshness — rather than on a timer.

## Choose a retrieval strategy

The default, `balancedRetrieval()`, is
`diversified(salienceWeighted(hybrid([bm25(), vectorSimilarity()])), λ=0.7)`.
Each part fixes a failure the others have:

| Strategy             | Fixes                                                   |
| -------------------- | ------------------------------------------------------- |
| `bm25()`             | Exact terms: an error string, a package name, a person  |
| `vectorSimilarity()` | Inflection and typos, where term matching finds nothing |
| `hybrid()`           | Keeping both, with `weighted` fusion preserving margin  |
| `salienceWeighted()` | Telling a superseded claim from its replacement         |
| `diversified()`      | Stopping restatements from eating the recall budget     |

Compose your own when the workload is different:

```ts
import { bm25, hybrid, salienceWeighted, vectorSimilarity } from "eve/memory/learning";

provider: learningMemory({
  retrieval: salienceWeighted(hybrid([bm25(), vectorSimilarity()], { method: "weighted" }), {
    halfLifeMs: 24 * 60 * 60 * 1_000,
  }),
});
```

Use `method: "weighted"` when a salience or diversity stage follows.
Reciprocal-rank fusion compresses every score into a narrow band, so an
additive recency term downstream overwhelms relevance — measured at a 0.82
drop in first-hit rank on exact-term queries. `research/learning-memory.md`
records the full comparison.

## Choose a distiller

The default `heuristicDistiller()` extracts stated preferences, corrections,
and standing constraints by pattern. It is conservative on purpose: a wrong
memory is worse than a missing one, because it is recalled into every future
turn.

For better extraction, pass a model:

```ts
import { learningMemory, modelDistiller } from "eve/memory/learning";

provider: learningMemory({
  distiller: modelDistiller({ model: "openai/gpt-5.6-luna-fast" }),
});
```

The model runs after the turn has already answered, so a failed or unparsable
distillation yields no records rather than failing the turn. It also turns
`reflective()` from frequency-based theme detection into written insight.

## Choose an embedding

`hashingEmbedding()` builds a unit vector from hashed terms and character
trigrams. It matches inflection and typos well and genuine synonymy poorly.
When paraphrase matching matters, implement `MemoryEmbedding` over a real
embedding model and pass it — the record's stored `vectorId` lets a changed
embedding be detected.

## What it does not do

Learning memory changes what the agent _knows_, not what the agent _is_. It
never edits instructions, tools, or skills. Turning learned experience into
changes to the agent itself is [self-improvement](./self-improvement), a
separate layer built on this one.

## What to read next

- [Memory](./memory): the provider contract, scope, and lifecycle this builds on.
- [Self-improvement](./self-improvement): learning that changes the agent.
- [Multi-tenant memory](./patterns/multi-tenant-memory): isolating any provider by tenant.
