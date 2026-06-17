import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import {
  extractVercelCredentialBrokering,
  resolveVercelCredentialPolicy,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { isSandboxAuthorizationInterrupt } from "#execution/sandbox/authorization-interrupt.js";
import { CallbackBaseUrlKey, PendingAuthorizationResultKey } from "#harness/authorization.js";

function requiredError(): Error {
  const error = new Error("auth required");
  error.name = "ConnectionAuthorizationRequiredError";
  return error;
}

function createUserContext(): ContextContainer {
  const context = new ContextContainer();
  context.set(SessionIdKey, "session-auth");
  context.set(AuthKey, {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: "user-1",
    principalType: "user",
  });
  return context;
}

describe("Vercel sandbox credential brokering", () => {
  it("resolves non-interactive credentials for the policy builder", async () => {
    const getToken = vi.fn(async () => ({
      expiresAt: 123,
      token: "secret-token",
    }));
    const buildPolicy = vi.fn(({ service }) => ({
      allow: {
        "api.example.com": [
          {
            transform: [
              {
                headers: {
                  authorization: `Bearer ${service.token}`,
                },
              },
            ],
          },
        ],
      },
    }));
    const { brokering } = extractVercelCredentialBrokering({
      credentials: { service: { getToken } },
      networkPolicy: buildPolicy,
    });

    expect(brokering).toBeDefined();
    await expect(resolveVercelCredentialPolicy(brokering!, "session-key")).resolves.toEqual({
      allow: {
        "api.example.com": [
          {
            transform: [
              {
                headers: {
                  authorization: "Bearer secret-token",
                },
              },
            ],
          },
        ],
      },
    });
    expect(getToken).toHaveBeenCalledWith({
      connection: { url: "" },
      principal: { type: "app" },
    });
    expect(buildPolicy).toHaveBeenNthCalledWith(1, {
      service: { token: "" },
    });
    expect(buildPolicy).toHaveBeenNthCalledWith(2, {
      service: { expiresAt: 123, token: "secret-token" },
    });
  });

  it("uses an empty token when a credential is unavailable", async () => {
    const { brokering } = extractVercelCredentialBrokering({
      credentials: {
        service: {
          getToken: async () => {
            throw new Error("not connected");
          },
        },
      },
      networkPolicy: ({ service }) => ({
        allow: {
          "api.example.com": [
            {
              transform: [
                {
                  headers: {
                    authorization: `Bearer ${service.token}`,
                  },
                },
              ],
            },
          ],
        },
      }),
    });

    await expect(resolveVercelCredentialPolicy(brokering!, "session-key")).resolves.toEqual({
      allow: {
        "api.example.com": [
          {
            transform: [
              {
                headers: {
                  authorization: "Bearer ",
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("rejects incomplete brokering definitions", () => {
    expect(() =>
      extractVercelCredentialBrokering({
        credentials: { service: { getToken: async () => ({ token: "secret" }) } },
        networkPolicy: "deny-all",
      }),
    ).toThrow(/requires `networkPolicy` to be a function/);

    expect(() =>
      extractVercelCredentialBrokering({
        networkPolicy: () => "deny-all",
      }),
    ).toThrow(/requires at least one entry in `credentials`/);
  });

  it("parks with an interactive authorization challenge", async () => {
    const startAuthorization = vi.fn(async () => ({
      challenge: { displayName: "Example", url: "https://example.com/authorize" },
      resume: { verifier: "pkce" },
    }));
    const { brokering } = extractVercelCredentialBrokering({
      credentials: {
        service: {
          completeAuthorization: async () => ({ token: "secret" }),
          getToken: async () => {
            throw requiredError();
          },
          principalType: "user",
          startAuthorization,
        },
      },
      networkPolicy: () => "deny-all",
    });
    const context = createUserContext();
    context.set(CallbackBaseUrlKey, "https://app.example");

    const error = await contextStorage
      .run(context, () => resolveVercelCredentialPolicy(brokering!, "session-key"))
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(isSandboxAuthorizationInterrupt(error)).toBe(true);
    if (!isSandboxAuthorizationInterrupt(error)) throw new Error("expected interrupt");
    expect(error.signal.challenges).toEqual([
      expect.objectContaining({
        challenge: {
          displayName: "Example",
          url: "https://example.com/authorize",
        },
        name: "sandbox:session-key:service",
        resume: { verifier: "pkce" },
      }),
    ]);
    expect(startAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: expect.stringContaining(
          "/connections/sandbox%3Asession-key%3Aservice/callback/",
        ),
        principal: expect.objectContaining({
          id: "user-1",
          issuer: "test",
          type: "user",
        }),
      }),
    );
  });

  it("completes interactive authorization and builds the credentialed policy on resume", async () => {
    const completeAuthorization = vi.fn(async () => ({ token: "minted-token" }));
    const { brokering } = extractVercelCredentialBrokering({
      credentials: {
        service: {
          completeAuthorization,
          getToken: async () => {
            throw requiredError();
          },
          principalType: "user",
          startAuthorization: async () => ({
            challenge: { url: "https://example.com/authorize" },
          }),
        },
      },
      networkPolicy: ({ service }) => ({
        allow: {
          "api.example.com": [
            {
              transform: [
                {
                  headers: {
                    authorization: `Bearer ${service.token}`,
                  },
                },
              ],
            },
          ],
        },
      }),
    });
    const context = createUserContext();
    context.set(PendingAuthorizationResultKey, [
      {
        callback: {
          method: "GET",
          params: { code: "abc" },
        },
        hookUrl: "https://app.example/callback",
        name: "sandbox:session-key:service",
        resume: { verifier: "pkce" },
      },
    ]);

    await expect(
      contextStorage.run(context, () => resolveVercelCredentialPolicy(brokering!, "session-key")),
    ).resolves.toEqual({
      allow: {
        "api.example.com": [
          {
            transform: [
              {
                headers: {
                  authorization: "Bearer minted-token",
                },
              },
            ],
          },
        ],
      },
    });
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        callback: {
          method: "GET",
          params: { code: "abc" },
        },
        resume: { verifier: "pkce" },
      }),
    );
  });
});
