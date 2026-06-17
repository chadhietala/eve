import type { ConnectionAuthDefinition, TokenResult } from "#runtime/connections/types.js";

/**
 * Authorization strategy for one brokered sandbox credential.
 *
 * Uses the same non-interactive or interactive shapes as connection
 * authorization. When an interactive strategy requires consent, eve keeps
 * the live sandbox on the credential-free policy, parks the calling tool, and
 * applies the resolved policy after authorization resumes.
 */
export type SandboxCredentialAuth = ConnectionAuthDefinition;

/**
 * Author-chosen credential labels mapped to authorization strategies.
 */
export type SandboxCredentialMap = Readonly<Record<string, SandboxCredentialAuth>>;

/**
 * Credentials resolved for one step and handed to a network-policy builder.
 */
export type ResolvedSandboxCredentials<C extends SandboxCredentialMap> = {
  readonly [K in keyof C]: TokenResult;
};
