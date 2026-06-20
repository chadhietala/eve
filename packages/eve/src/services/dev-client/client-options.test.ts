import { describe, expect, it } from "vitest";

import { EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER } from "#protocol/local-dev-auth.js";

import { resolveDevelopmentOidcToken } from "./request-headers.js";

import { resolveDevelopmentClientOptions } from "./client-options.js";

describe("resolveDevelopmentClientOptions", () => {
  it("targets the given host and resolves headers lazily", () => {
    const options = resolveDevelopmentClientOptions("http://localhost:3000");
    expect(options.host).toBe("http://localhost:3000");
    expect(typeof options.headers).toBe("function");
  });

  it("does not preserve completed sessions across dev prompts", () => {
    expect(resolveDevelopmentClientOptions("http://localhost:3000").preserveCompletedSessions).toBe(
      undefined,
    );
  });

  it("skips the OIDC bearer for local hosts", () => {
    for (const url of [
      "http://localhost:3000",
      "http://agent.localhost:3000",
      "http://127.0.0.1:3000",
      "http://127.5.6.7:3000",
      "http://[::1]:3000",
    ]) {
      expect(resolveDevelopmentClientOptions(url).auth).toBeUndefined();
    }
  });

  it("does not treat wildcard and private-network addresses as loopback clients", () => {
    for (const url of ["http://0.0.0.0:3000", "http://10.0.0.5:3000"]) {
      expect(resolveDevelopmentClientOptions(url).auth).toEqual({
        bearer: resolveDevelopmentOidcToken,
      });
    }
  });

  it("attaches the dev OIDC bearer for remote hosts", () => {
    const options = resolveDevelopmentClientOptions("https://example.com");
    expect(options.auth).toEqual({ bearer: resolveDevelopmentOidcToken });
  });

  it("sends the Vercel CLI user only to the local server", async () => {
    let credential = "local-secret";
    const local = resolveDevelopmentClientOptions("http://localhost:3000", {
      resolveLocalUserCredential: () => credential,
    });
    const remote = resolveDevelopmentClientOptions("https://example.com", {
      resolveLocalUserCredential: () => credential,
    });

    expect(typeof local.headers).toBe("function");
    expect(typeof remote.headers).toBe("function");
    if (typeof local.headers !== "function" || typeof remote.headers !== "function") {
      throw new Error("Expected lazy development headers.");
    }

    await expect(local.headers()).resolves.toMatchObject({
      [EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER]: "local-secret",
    });
    credential = "rotated-secret";
    await expect(local.headers()).resolves.toMatchObject({
      [EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER]: "rotated-secret",
    });
    await expect(remote.headers()).resolves.not.toHaveProperty(
      EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER,
    );
  });
});
