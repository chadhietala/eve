import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGrant: vi.fn(),
}));

vi.mock("#internal/local-development-auth.js", () => ({
  LocalDevelopmentAuthServer: {
    fromMetadata: () => ({ create: mocks.createGrant }),
  },
}));

import { createLocalDevelopmentUserCredential } from "./local-user-credential.js";

const server = {
  serverInstanceId: "a".repeat(32),
  version: 1,
} as const;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("createLocalDevelopmentUserCredential", () => {
  it("rotates immutable grants when the resolved Vercel user changes", async () => {
    let userId = "vercel-user-a";
    const firstGrant = grant("token-a");
    const secondGrant = grant("token-b");
    mocks.createGrant
      .mockResolvedValueOnce({ ok: true, value: firstGrant })
      .mockResolvedValueOnce({ ok: true, value: secondGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveServer: async () => server,
      resolveUserId: async () => userId,
    });

    expect(credential.token).toBeUndefined();
    await credential.refresh();
    expect(credential.token).toBe("token-a");

    await credential.refresh();
    expect(mocks.createGrant).toHaveBeenCalledTimes(1);

    userId = "vercel-user-b";
    await credential.refresh();
    expect(credential.token).toBe("token-b");
    expect(firstGrant.dispose).toHaveBeenCalledOnce();

    await credential.dispose();
    expect(secondGrant.dispose).toHaveBeenCalledOnce();
  });

  it("revokes the current grant when identity can no longer be resolved", async () => {
    let userId: string | undefined = "vercel-user-a";
    const firstGrant = grant("token-a");
    mocks.createGrant.mockResolvedValueOnce({ ok: true, value: firstGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveServer: async () => server,
      resolveUserId: async () => userId,
    });
    await credential.refresh();

    userId = undefined;
    await credential.refresh();

    expect(credential.token).toBeUndefined();
    expect(firstGrant.dispose).toHaveBeenCalledOnce();
    await credential.dispose();
  });

  it("stops exposing a grant whose revocation failed and retries before replacing it", async () => {
    let userId = "vercel-user-a";
    const firstGrant = grant("token-a");
    const replacementGrant = grant("token-b");
    firstGrant.dispose.mockRejectedValueOnce(new Error("revoke failed"));
    mocks.createGrant
      .mockResolvedValueOnce({ ok: true, value: firstGrant })
      .mockResolvedValueOnce({ ok: true, value: replacementGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveServer: async () => server,
      resolveUserId: async () => userId,
    });
    await credential.refresh();

    userId = "vercel-user-b";
    await expect(credential.refresh()).rejects.toThrow("revoke failed");
    expect(credential.token).toBeUndefined();
    expect(mocks.createGrant).toHaveBeenCalledTimes(1);

    await credential.refresh();
    expect(credential.token).toBe("token-b");
    await credential.dispose();
  });

  it("does not retain the previous user's grant when creating its replacement fails", async () => {
    let userId = "vercel-user-a";
    const firstGrant = grant("token-a");
    const cause = new Error("write failed");
    mocks.createGrant
      .mockResolvedValueOnce({ ok: true, value: firstGrant })
      .mockResolvedValueOnce({ ok: false, error: { kind: "io", cause } });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveServer: async () => server,
      resolveUserId: async () => userId,
    });
    await credential.refresh();

    userId = "vercel-user-b";
    await expect(credential.refresh()).rejects.toThrow("write failed");

    expect(credential.token).toBeUndefined();
    expect(firstGrant.dispose).toHaveBeenCalledOnce();
    await credential.dispose();
  });

  it("can retry disposal when revoking the current grant fails", async () => {
    const firstGrant = grant("token-a");
    firstGrant.dispose.mockRejectedValueOnce(new Error("revoke failed"));
    mocks.createGrant.mockResolvedValueOnce({ ok: true, value: firstGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveServer: async () => server,
      resolveUserId: async () => "vercel-user-a",
    });
    await credential.refresh();

    await expect(credential.dispose()).rejects.toThrow("revoke failed");
    expect(credential.token).toBeUndefined();

    await credential.dispose();
    expect(credential.token).toBeUndefined();
    expect(firstGrant.dispose).toHaveBeenCalledTimes(2);
  });

  it("applies the latest unavailable identity result after a concurrent rotation", async () => {
    let userId: string | undefined = "vercel-user-a";
    let finishRevocation: () => void = () => {};
    const firstGrant = grant("token-a");
    const secondGrant = grant("token-b");
    firstGrant.dispose.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishRevocation = resolve;
        }),
    );
    mocks.createGrant
      .mockResolvedValueOnce({ ok: true, value: firstGrant })
      .mockResolvedValueOnce({ ok: true, value: secondGrant });
    const credential = createLocalDevelopmentUserCredential({
      appRoot: "/tmp/eve-agent",
      resolveServer: async () => server,
      resolveUserId: async () => userId,
    });
    await credential.refresh();

    userId = "vercel-user-b";
    const rotation = credential.refresh();
    await vi.waitFor(() => expect(firstGrant.dispose).toHaveBeenCalledOnce());
    userId = undefined;
    const unavailableRefresh = credential.refresh();
    finishRevocation();
    await Promise.all([rotation, unavailableRefresh]);

    expect(credential.token).toBeUndefined();
    expect(secondGrant.dispose).toHaveBeenCalledOnce();
    await credential.dispose();
  });
});

function grant(token: string) {
  return { token, dispose: vi.fn(async () => {}) };
}
