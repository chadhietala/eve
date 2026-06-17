import type { SandboxCreateOptions } from "#compiled/@vercel/sandbox/index.js";
import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { SandboxAuthorizationInterrupt } from "#execution/sandbox/authorization-interrupt.js";
import { type AuthorizationSignal, requestAuthorization } from "#harness/authorization.js";
import { createLogger } from "#internal/logging.js";
import {
  ConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";
import type { SandboxCredentialMap } from "#public/sandbox/credentials.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import {
  completeScopedAuthorization,
  evictScopedToken,
  resolveScopedToken,
  startScopedAuthorization,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import {
  type AuthorizationDefinition,
  supportsInteractiveAuthorization,
  type TokenResult,
} from "#runtime/connections/types.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

const logger = createLogger("sandbox.vercel-credentials");

type ResolvedCredentialEntry =
  | {
      readonly kind: "authorization";
      readonly label: string;
      readonly signal: AuthorizationSignal;
    }
  | {
      readonly kind: "token";
      readonly label: string;
      readonly token: TokenResult;
    };

export function getVercelSandboxFetch(
  createOptions: SandboxCreateOptions,
): typeof globalThis.fetch {
  const fetchOverride = (createOptions as { readonly fetch?: typeof globalThis.fetch }).fetch;
  return fetchOverride ?? globalThis.fetch;
}

export async function getVercelSandboxCredentials(
  createOptions: SandboxCreateOptions,
): Promise<VercelSandboxCredentials> {
  const teamId =
    readNonEmptyString(createOptions, "teamId") ??
    readNonEmptyEnvironmentVariable("VERCEL_TEAM_ID") ??
    readNonEmptyEnvironmentVariable("VERCEL_ORG_ID");
  const projectId =
    readNonEmptyString(createOptions, "projectId") ??
    readNonEmptyEnvironmentVariable("VERCEL_PROJECT_ID");
  const envToken =
    readNonEmptyString(createOptions, "token") ??
    readNonEmptyEnvironmentVariable("VERCEL_OIDC_TOKEN") ??
    readNonEmptyEnvironmentVariable("VERCEL_TOKEN");

  if (envToken && teamId && projectId) {
    return { projectId, teamId, token: envToken };
  }

  const oidcToken = await getVercelOidcToken({
    project: projectId,
    team: teamId,
  });
  return getVercelSandboxCredentialsFromOidcToken(oidcToken);
}

export interface VercelCredentialBrokering {
  readonly buildPolicy: (credentials: Record<string, TokenResult>) => SandboxNetworkPolicy;
  readonly credentials: Readonly<Record<string, Readonly<AuthorizationDefinition>>>;
  readonly emptyPolicy: SandboxNetworkPolicy;
}

export function extractVercelCredentialBrokering<C extends SandboxCredentialMap>(
  options: VercelSandboxCreateOptions<C> | undefined,
): {
  readonly brokering: VercelCredentialBrokering | undefined;
  readonly createOptions: SandboxCreateOptions;
} {
  const { credentials, networkPolicy, ...createOptions } = options ?? {};
  const labels = Object.keys(credentials ?? {});

  if (typeof networkPolicy !== "function") {
    if (labels.length > 0) {
      throw new Error(
        "vercel(): `credentials` requires `networkPolicy` to be a function of the resolved credentials.",
      );
    }
    return {
      brokering: undefined,
      createOptions:
        networkPolicy === undefined ? createOptions : { ...createOptions, networkPolicy },
    };
  }

  if (labels.length === 0) {
    throw new Error(
      "vercel(): a function-form `networkPolicy` requires at least one entry in `credentials`.",
    );
  }

  const normalized: Record<string, AuthorizationDefinition> = {};
  for (const [label, auth] of Object.entries(credentials ?? {})) {
    const authorization = normalizeAuthorizationSpec(auth, `vercel() credential "${label}":`);
    normalized[label] = authorization;
  }

  const buildPolicy = networkPolicy as VercelCredentialBrokering["buildPolicy"];
  return {
    brokering: {
      buildPolicy,
      credentials: normalized,
      emptyPolicy: buildPolicy(createEmptyCredentials(labels)),
    },
    createOptions,
  };
}

export async function resolveVercelCredentialPolicy(
  brokering: VercelCredentialBrokering,
  sandboxScope: string,
): Promise<SandboxNetworkPolicy> {
  const entries: ResolvedCredentialEntry[] = await Promise.all(
    Object.entries(brokering.credentials).map(async ([label, authorization]) => {
      const scoped = createScopedCredential(sandboxScope, label, authorization);
      const justAuthorized = await completeScopedAuthorization(scoped);

      try {
        return {
          kind: "token",
          label,
          token: await resolveScopedToken(scoped),
        } as const;
      } catch (error) {
        if (isConnectionAuthorizationRequiredError(error)) {
          if (justAuthorized) {
            throw new ConnectionAuthorizationFailedError(scoped.scope, {
              message:
                `Sandbox credential "${label}" rejected the token immediately after ` +
                "authorization.",
              reason: "token_rejected_after_authorization",
              retryable: false,
            });
          }

          await evictScopedToken(scoped);
          const signal = await startScopedAuthorization(scoped);
          if (signal !== undefined) {
            return { kind: "authorization", label, signal } as const;
          }
          if (supportsInteractiveAuthorization(authorization)) {
            throw new ConnectionAuthorizationFailedError(scoped.scope, {
              message:
                `Sandbox credential "${label}" requires sign-in, but no authorization ` +
                "callback URL could be minted for this run (missing session context).",
              reason: "authorization_callback_unavailable",
              retryable: false,
            });
          }
        }

        logger.warn("sandbox credential unavailable; applying empty token", {
          credential: label,
          error,
        });
        return { kind: "token", label, token: { token: "" } } as const;
      }
    }),
  );

  const challenges = entries.flatMap((entry) =>
    entry.kind === "authorization" ? entry.signal.challenges : [],
  );
  if (challenges.length > 0) {
    throw new SandboxAuthorizationInterrupt(requestAuthorization(challenges));
  }

  return brokering.buildPolicy(
    Object.fromEntries(
      entries
        .filter(
          (entry): entry is Extract<ResolvedCredentialEntry, { readonly kind: "token" }> =>
            entry.kind === "token",
        )
        .map((entry) => [entry.label, entry.token]),
    ),
  );
}

function createScopedCredential(
  sandboxScope: string,
  label: string,
  authorization: Readonly<AuthorizationDefinition>,
): ScopedAuthorization {
  return {
    authorization,
    connection: { url: "" },
    scope: `sandbox:${sandboxScope}:${label}`,
  };
}

function createEmptyCredentials(labels: readonly string[]): Record<string, TokenResult> {
  return Object.fromEntries(labels.map((label) => [label, { token: "" }]));
}

function readNonEmptyString(object: object, key: string): string | undefined {
  const value = (object as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNonEmptyEnvironmentVariable(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getVercelSandboxCredentialsFromOidcToken(token: string): VercelSandboxCredentials {
  const payloadSegment = token.split(".")[1];
  if (payloadSegment === undefined) {
    throw new Error("Invalid Vercel OIDC token: missing payload.");
  }

  const payload = JSON.parse(
    Buffer.from(base64UrlToBase64(payloadSegment), "base64").toString("utf8"),
  ) as { owner_id?: unknown; project_id?: unknown };
  const teamId = typeof payload.owner_id === "string" ? payload.owner_id : undefined;
  const projectId = typeof payload.project_id === "string" ? payload.project_id : undefined;

  if (teamId === undefined || projectId === undefined) {
    throw new Error("Invalid Vercel OIDC token: missing owner_id or project_id.");
  }

  return { projectId, teamId, token };
}

function base64UrlToBase64(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
}

export interface VercelSandboxCredentials {
  readonly projectId: string;
  readonly teamId: string;
  readonly token: string;
}
