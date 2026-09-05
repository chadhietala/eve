---
issue: "chadhietala/eve branch claude/eve-agents-desktop-computer-use-r50l3o (repository issues are disabled; tracked on the branch)"
status: proposed
last_updated: "2026-09-05"
---

# Continuous-learning memory

## Proposal

`learningMemory()` is a memory provider that learns from what the agent
does. Every turn, several _architectures_ write what they observed; every
turn, a _retrieval strategy_ ranks the whole store against what the agent is
about to do and recalls the top slice inside a character budget.

The provider is a composition of four seams, each replaceable on its own:

| Seam         | Decides                               | Default                |
| ------------ | ------------------------------------- | ---------------------- |
| Architecture | What is worth writing                 | All four, together     |
| Retrieval    | What is worth recalling               | `balancedRetrieval()`  |
| Distiller    | How raw conversation becomes a record | `heuristicDistiller()` |
| Embedding    | How text becomes a vector             | `hashingEmbedding()`   |

Every default is deterministic and needs neither a model nor a network, so an
agent starts learning on its first turn instead of after a pipeline is
provisioned. An application that wants model-quality extraction or true
paraphrase matching replaces one seam, not the system.

Storage reuses `MemoryDocumentBackend` — the same seam `fileMemory()` already
uses — rather than introducing a second storage abstraction. Learning memory
therefore inherits Vercel Blob, in-memory, and application backends for free.
The cost is a read-modify-write per capture, which is the right trade at the
scale one scope's memory reaches (bounded to 512 records and 512 KiB, evicted
by standing value).

## Authoring API

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

The slot's provider tools become `experience__remember`,
`experience__forget`, and `experience__search`.

## Architectures

| Architecture   | Writes                                                     |
| -------------- | ---------------------------------------------------------- |
| `episodic()`   | One record per turn: what was asked, what ran, what failed |
| `semantic()`   | Keyed standing facts, so a later statement supersedes      |
| `procedural()` | The tool sequence that worked, and the step that failed    |
| `reflective()` | Periodic consolidation of the recent episodic trace        |

They are additive because they answer different questions. Retrieval ranks
across all of them, so adding an architecture widens what can be recalled
without changing how recall works.

`reflective()` prefers a distiller's insights and falls back to
frequency-based theme detection, so consolidation still happens with no model
configured.

## Retrieval: the measured comparison

The default was chosen by measurement, not by preference. The benchmark in
`packages/eve/src/public/memory/learning/retrieval-benchmark.test.ts` builds a
216-record corpus from a fixed seed with 48 queries in four families, each
isolating one failure mode: **exact** terms, **paraphrase** (inflection and
typos), **recency** (a superseded claim beside its replacement), and
**redundancy** (nine restatements crowding out a second relevant facet).

| Strategy                                             | MRR       | nDCG@8    | recall@8  | ms/query |
| ---------------------------------------------------- | --------- | --------- | --------- | -------- |
| `bm25`                                               | 0.709     | 0.733     | 0.958     | 0.56     |
| `vector`                                             | 0.837     | 0.777     | 0.854     | 0.13     |
| `hybrid(rrf)`                                        | 0.762     | 0.737     | 0.896     | 0.50     |
| `hybrid(weighted)`                                   | 0.830     | 0.772     | 0.854     | 0.45     |
| `salience(bm25)`                                     | 0.844     | 0.839     | 0.958     | 0.37     |
| `salience(vector)`                                   | 0.773     | 0.738     | 0.875     | 0.07     |
| `salience(hybrid(rrf))`                              | 0.614     | 0.631     | 0.875     | 0.34     |
| `salience(hybrid(weighted))`                         | 0.944     | 0.883     | 0.917     | 0.28     |
| `diversified(hybrid(weighted), λ=0.8)`               | 0.829     | 0.869     | 1.000     | 0.42     |
| `diversified(salience(hybrid(weighted)), λ=0.9)`     | 0.941     | 0.918     | 0.979     | 0.38     |
| **`diversified(salience(hybrid(weighted)), λ=0.7)`** | **0.936** | **0.943** | **0.979** | **0.35** |

Per-family (MRR, except redundancy which reports nDCG@8):

| Strategy                                             | exact | paraphrase | recency | redundancy |
| ---------------------------------------------------- | ----- | ---------- | ------- | ---------- |
| `bm25`                                               | 0.958 | 0.376      | 0.500   | 0.844      |
| `vector`                                             | 0.958 | 0.861      | 0.528   | 0.613      |
| `hybrid(weighted)`                                   | 0.958 | 0.861      | 0.500   | 0.613      |
| `salience(hybrid(weighted))`                         | 1.000 | 0.778      | 1.000   | 0.717      |
| **`diversified(salience(hybrid(weighted)), λ=0.7)`** | 1.000 | 0.743      | 1.000   | 0.987      |

What the numbers say:

- **Lexical and semantic are complementary, and fusion must preserve margin.**
  BM25 owns exact terms (0.958) and collapses on inflection and typos (0.376);
  the hashed vector is the reverse. Weighted fusion keeps both. Reciprocal-rank
  fusion does not: it flattens every score into a narrow band, so the additive
  recency and importance terms downstream swamp relevance —
  `salience(hybrid(rrf))` drops to 0.125 MRR on exact terms. RRF is the wrong
  fusion for a pipeline that adds a salience term afterwards.
- **Salience is what makes a memory store usable over time.** Without it, a
  superseded claim and its replacement are indistinguishable (0.500 on the
  recency family — a coin flip). With it, the fresh record wins every time.
- **Diversity is what protects the recall budget.** Recall is capped by
  characters, so nine restatements of one fact cost the slots a different fact
  needed: redundancy nDCG goes from 0.717 to 0.987 for a 0.07 ms/query cost and
  a 0.008 MRR give-back.

The default is therefore `diversified(salience(hybrid(bm25, vector,
weighted)), λ=0.7)`: the best nDCG@8 of every strategy measured, within 0.008
of the best MRR, within 0.021 of the best recall, at 0.35 ms/query against a
216-record store.

Caveat recorded honestly: the corpus is synthetic, and the paraphrase family
is generated by inflection and single-character deletion. A hashed character
n-gram vector handles those well and would handle genuine synonymy far worse.
The number to distrust in the table is the vector column on the paraphrase
family; the shape of the comparison — that fusion, salience, and diversity
each fix a different failure — is what the benchmark establishes.

## Externally observable semantics

- Recall returns one keyed message (`learning-memory-recall`), so each turn's
  recall replaces the previous one instead of accumulating.
- The recalled message leads with up to two _pinned_ records — the
  highest standing value in the store — before query matches, because a
  standing fact such as the caller's name has no term overlap with most turns.
- A record with a `key` replaces the record holding that key. An exact
  restatement reinforces the existing record's confidence rather than
  duplicating it.
- Records recalled in a turn have their access count incremented when that
  turn settles, in the same write capture already performs. Reinforcement is
  best-effort and is lost if the process dies mid-turn.
- Eviction is by standing value: importance, confidence, proven usefulness,
  and freshness. Nothing expires on a timer.
- A capture failure is diagnosed after the response and never rewrites the
  completed turn, per the memory provider contract.

## Boundaries

- No model call happens by default. `modelDistiller()` is opt-in and its
  failures yield no records rather than failing the turn.
- Learning memory does not modify the agent. Turning learned experience into
  changes to instructions and skills is a separate layer; see
  `research/self-improvement.md`.
