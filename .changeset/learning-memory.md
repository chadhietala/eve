---
"eve": patch
---

Add `eve/memory/learning`: a continuous-learning memory provider built on eve's memory primitives. `learningMemory()` writes episodic, semantic, procedural, and reflective records from each settled turn and recalls the most relevant of them on the next one, with pluggable architectures, retrieval strategies, distillers, and embeddings. Every default is deterministic and needs no model or network.
