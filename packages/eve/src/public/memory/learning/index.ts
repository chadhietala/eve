/**
 * Continuous-learning memory built on eve's memory primitives.
 *
 * `learningMemory()` is a `MemoryProvider`: bind it to a slot with
 * `defineMemory()` and the agent starts forming, ranking, and recalling
 * memory from its own experience. Everything below it is a seam — the
 * architectures that decide what is worth writing, the retrieval strategy
 * that decides what is worth recalling, the distiller that extracts records,
 * and the embedding that vectorizes them — so an application can replace one
 * part without rebuilding the rest.
 */
export {
  episodic,
  procedural,
  reflective,
  semantic,
  type EpisodicOptions,
  type MemoryArchitecture,
  type MemoryArchitectureContext,
  type ProceduralOptions,
  type ReflectiveOptions,
} from "#public/memory/learning/architectures.js";
export {
  heuristicDistiller,
  modelDistiller,
  type DistillInput,
  type MemoryDistiller,
  type ModelDistillerOptions,
} from "#public/memory/learning/distiller.js";
export {
  cosineSimilarity,
  hashingEmbedding,
  type HashingEmbeddingOptions,
  type MemoryEmbedding,
} from "#public/memory/learning/embedding.js";
export { learningMemory, type LearningMemoryOptions } from "#public/memory/learning/provider.js";
export {
  MAX_RECORD_CHARACTERS,
  type MemoryRecord,
  type MemoryRecordInput,
  type MemoryRecordKind,
} from "#public/memory/learning/record.js";
export {
  balancedRetrieval,
  bm25,
  diversified,
  hybrid,
  salienceWeighted,
  vectorSimilarity,
  type Bm25Options,
  type HybridOptions,
  type MemoryRetrieval,
  type RankedRecord,
  type RetrievalQuery,
  type SalienceOptions,
} from "#public/memory/learning/retrieval.js";
export {
  createLearningStore,
  type LearningStore,
  type LearningStoreOptions,
} from "#public/memory/learning/store.js";
