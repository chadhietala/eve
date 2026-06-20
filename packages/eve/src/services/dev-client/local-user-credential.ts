import {
  LocalDevelopmentAuthServer,
  type LocalDevelopmentAuthCreateError,
  type LocalDevelopmentUserGrantHandle,
} from "#internal/local-development-auth.js";
import type { LocalDevelopmentAuthMetadata } from "#protocol/local-dev-auth.js";

/** Temporary per-TUI credential for one authenticated local development user. */
export interface LocalDevelopmentUserCredential {
  readonly token: string | undefined;
  /** Re-resolves the Vercel CLI user and rotates the immutable grant when it changes. */
  refresh(): Promise<void>;
  /** Revokes the grant currently owned by this TUI. */
  dispose(): Promise<void>;
}

/**
 * Creates one local TUI credential. The server registry owns the principal
 * mapping; requests carry only the temporary token that addresses it.
 */
export function createLocalDevelopmentUserCredential(input: {
  readonly appRoot: string;
  /** Resolves the active server so an attached TUI can survive a server restart. */
  readonly resolveServer: () => Promise<LocalDevelopmentAuthMetadata | undefined>;
  readonly resolveUserId: () => Promise<string | undefined>;
}): LocalDevelopmentUserCredential {
  type CredentialState =
    | { readonly kind: "empty" }
    | {
        readonly kind: "active";
        readonly grant: LocalDevelopmentUserGrantHandle;
        readonly serverInstanceId: string;
        readonly userId: string;
      }
    | { readonly kind: "revoking"; readonly grant: LocalDevelopmentUserGrantHandle };

  let state: CredentialState = { kind: "empty" };
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let refreshTail = Promise.resolve();

  const revokeCurrentGrant = async (): Promise<void> => {
    if (state.kind === "empty") return;
    if (state.kind === "active") state = { kind: "revoking", grant: state.grant };
    const revoking = state;
    await revoking.grant.dispose();
    if (state === revoking) state = { kind: "empty" };
  };

  const refreshOnce = async (): Promise<void> => {
    if (disposed) return;

    let server: LocalDevelopmentAuthMetadata | undefined;
    let userId: string | undefined;
    try {
      server = await input.resolveServer();
      userId = (await input.resolveUserId())?.trim() || undefined;
    } catch {
      server = undefined;
      userId = undefined;
    }
    if (disposed) return;
    if (
      state.kind === "active" &&
      server !== undefined &&
      userId !== undefined &&
      state.serverInstanceId === server.serverInstanceId &&
      state.userId === userId
    ) {
      return;
    }

    await revokeCurrentGrant();
    if (disposed || server === undefined || userId === undefined) return;

    const authServer = LocalDevelopmentAuthServer.fromMetadata({
      appRoot: input.appRoot,
      metadata: server,
    });
    const createdGrant = await authServer.create({ userId });
    if (!createdGrant.ok) throw toLocalDevelopmentAuthCreateError(createdGrant.error);
    const nextGrant = createdGrant.value;
    if (disposed) {
      await nextGrant.dispose();
      return;
    }

    state = {
      kind: "active",
      grant: nextGrant,
      serverInstanceId: server.serverInstanceId,
      userId,
    };
  };

  return {
    get token() {
      return state.kind === "active" ? state.grant.token : undefined;
    },
    async refresh() {
      const refresh = refreshTail.then(refreshOnce);
      refreshTail = refresh.catch(() => {});
      await refresh;
    },
    async dispose() {
      if (disposePromise === undefined) {
        disposed = true;
        disposePromise = (async () => {
          await refreshTail;
          await revokeCurrentGrant();
        })().catch((error: unknown) => {
          disposePromise = undefined;
          throw error;
        });
      }
      await disposePromise;
    },
  };
}

function toLocalDevelopmentAuthCreateError(error: LocalDevelopmentAuthCreateError): Error {
  if (error.kind === "io" && error.cause instanceof Error) return error.cause;
  if (error.kind === "invalid-user-id") {
    return new Error("The Vercel CLI returned an invalid user id.");
  }
  return new Error("Failed to allocate a unique local development user credential.");
}
