/**
 * Learning that changes the agent, built on eve's memory primitives.
 *
 * `selfImprovement()` observes turns and proposes *directives* — rules about
 * how this agent should work here. A directive changes nothing until it is
 * activated, and activation is a gate the deployment chooses: a person's
 * approval by default, repeated confirmation when the deployment opts into
 * `autonomous`. Active directives reach the model two ways:
 * `learnedDirectives()` puts them in the running agent's instructions, and
 * `renderAgentPatch()` writes them into the agent's own source tree so the
 * change can be reviewed and committed like any other.
 */
export { experience, type ExperienceOptions } from "#public/self-improvement/architecture.js";
export {
  activeDirectives,
  applyPromotionPolicy,
  directiveStatus,
  formatDirectives,
  isApproved,
  isDirective,
  resolvePromotionPolicy,
  withApproval,
  withStatus,
  type DirectiveStatus,
  type FormatDirectivesOptions,
  type PromotionMode,
  type PromotionPolicy,
  type ResolvedPromotionPolicy,
} from "#public/self-improvement/directive.js";
export {
  learnedDirectives,
  type LearnedDirectivesOptions,
} from "#public/self-improvement/instructions.js";
export {
  applyAgentPatch,
  LEARNED_INSTRUCTIONS_PATH,
  MAX_PATCH_FILE_BYTES,
  renderAgentPatch,
  type AgentPatch,
  type AgentPatchFile,
  type ApplyAgentPatchOptions,
} from "#public/self-improvement/patch.js";
export {
  DEFAULT_DIRECTIVE_KEY,
  selfImprovement,
  type SelfImprovementOptions,
} from "#public/self-improvement/provider.js";
