import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

import {
  parseCreatedConnector,
  pickConnectConnector,
  setupConnectionConnector,
} from "./connection-connector.js";

vi.mock("#setup/primitives/run-vercel.js", () => ({
  captureVercel: vi.fn(),
  runVercel: vi.fn(),
  runVercelCaptureStdout: vi.fn(),
}));

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedRunVercel = vi.mocked(runVercel);
const mockedRunVercelCaptureStdout = vi.mocked(runVercelCaptureStdout);

const SERVICE = "mcp.linear.app";

/** `vercel connect create … -F json` stdout payload on CLI 54.x. */
function createConnectorJson(uid: string, id = "scl_linear"): string {
  return JSON.stringify({
    uid,
    id,
    type: "oauth",
    name: "linear",
    supportedSubjectTypes: ["user"],
  });
}

describe("parseCreatedConnector", () => {
  test("reads uid and id from `vercel connect create -F json` stdout", () => {
    expect(parseCreatedConnector(createConnectorJson("linear/my-agent", "scl_1"), "user")).toEqual({
      uid: "linear/my-agent",
      id: "scl_1",
    });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseCreatedConnector(`\n  ${createConnectorJson("linear/x")}  \n`, "user")?.uid).toBe(
      "linear/x",
    );
  });

  test("returns undefined for empty, non-JSON, or shape-mismatched stdout", () => {
    expect(parseCreatedConnector("", "user")).toBeUndefined();
    expect(parseCreatedConnector("   ", "user")).toBeUndefined();
    expect(parseCreatedConnector("Vercel CLI 54.9.1", "user")).toBeUndefined();
    expect(parseCreatedConnector(JSON.stringify({ uid: "linear/x" }), "user")).toBeUndefined();
    expect(parseCreatedConnector(JSON.stringify({ id: "scl_1" }), "user")).toBeUndefined();
    expect(parseCreatedConnector(JSON.stringify([1, 2, 3]), "user")).toBeUndefined();
    expect(
      parseCreatedConnector(
        JSON.stringify({ uid: "linear/stale", id: "scl_1", supportedSubjectTypes: [] }),
        "user",
      ),
    ).toBeUndefined();
  });
});

describe("pickConnectConnector", () => {
  test("reads the `clients` key emitted by the Connect API", () => {
    const list = {
      clients: [{ uid: "linear/my-agent", id: "scl_1", supportedSubjectTypes: ["user"] }],
    };
    expect(pickConnectConnector(list, SERVICE, "user")).toEqual({
      kind: "found",
      connector: { uid: "linear/my-agent", id: "scl_1" },
    });
  });

  test("prefers a connector attached to the project", () => {
    const list = {
      clients: [
        { uid: "linear/a", id: "1", supportedSubjectTypes: ["user"] },
        {
          uid: "linear/b",
          id: "2",
          supportedSubjectTypes: ["user"],
          includes: { projects: { items: [{ projectId: "prj_1" }] } },
        },
      ],
    };
    expect(pickConnectConnector(list, SERVICE, "user", "prj_1")).toEqual({
      kind: "found",
      connector: { uid: "linear/b", id: "2" },
    });
  });

  test("does not silently choose between multiple unattached connectors", () => {
    const list = {
      clients: [
        { uid: "linear/a", id: "1", supportedSubjectTypes: ["user"] },
        { uid: "linear/b", id: "2", supportedSubjectTypes: ["user"] },
      ],
    };
    expect(pickConnectConnector(list, SERVICE, "user")).toEqual({
      kind: "ambiguous",
      connectors: [
        { uid: "linear/a", id: "1" },
        { uid: "linear/b", id: "2" },
      ],
    });
  });

  test("accepts connectors whose type is not `oauth` (managed MCP connectors)", () => {
    const list = {
      clients: [{ uid: "linear/mcp", id: "1", type: "mcp", supportedSubjectTypes: ["user"] }],
    };
    expect(pickConnectConnector(list, SERVICE, "user")).toEqual({
      kind: "found",
      connector: { uid: "linear/mcp", id: "1" },
    });
  });

  test("defensively skips connectors whose reported service differs", () => {
    const list = {
      clients: [
        {
          uid: "notion/x",
          id: "1",
          service: "mcp.notion.com",
          supportedSubjectTypes: ["user"],
        },
        { uid: "linear/x", id: "2", service: SERVICE, supportedSubjectTypes: ["user"] },
      ],
    };
    expect(pickConnectConnector(list, SERVICE, "user")).toEqual({
      kind: "found",
      connector: { uid: "linear/x", id: "2" },
    });
  });

  test("skips connectors that do not support the required user subject", () => {
    const list = {
      clients: [
        {
          uid: "linear/stale",
          id: "1",
          service: SERVICE,
          supportedSubjectTypes: [],
        },
        {
          uid: "linear/current",
          id: "2",
          service: SERVICE,
          supportedSubjectTypes: ["user"],
        },
      ],
    };

    expect(pickConnectConnector(list, SERVICE, "user")).toEqual({
      kind: "found",
      connector: { uid: "linear/current", id: "2" },
    });
  });

  test("returns undefined for malformed input", () => {
    expect(pickConnectConnector(null, SERVICE, "user")).toEqual({ kind: "invalid" });
    expect(pickConnectConnector({}, SERVICE, "user")).toEqual({ kind: "invalid" });
    expect(pickConnectConnector({ clients: "nope" }, SERVICE, "user")).toEqual({
      kind: "invalid",
    });
  });
});

function createTestLog(): ChannelSetupLog {
  return {
    message: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    commandOutput: vi.fn(),
  };
}

/** Connector list payload returned by the Connect API. */
function connectApiList(connectorUid: string, projectId: string) {
  return JSON.stringify({
    clients: [
      {
        uid: connectorUid,
        id: "scl_linear",
        name: "linear",
        type: "oauth",
        typeName: "Linear",
        createdAt: 2,
        icon: null,
        backgroundColor: null,
        accentColor: null,
        service: SERVICE,
        supportedSubjectTypes: ["user"],
        includes: { projects: { items: [{ projectId }], hasMore: false } },
      },
    ],
    cursor: undefined,
  });
}

describe("setupConnectionConnector (end-to-end)", () => {
  let projectRoot: string;
  const PROJECT_ID = "prj_ExampleProjectId0000000000";

  beforeEach(async () => {
    vi.resetAllMocks();
    // The connector attach succeeds by default; failure is exercised separately.
    mockedRunVercel.mockResolvedValue(true);
    // No existing connector by default: the reuse lookup that now runs before
    // `create` finds nothing, so tests exercise the create path unless they
    // override this. Reuse is covered by its own test.
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ clients: [] }),
    });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createConnectorJson("linear/my-agent"),
    });
    projectRoot = await mkdtemp(join(tmpdir(), "eve-setup-connection-"));
    await mkdir(join(projectRoot, ".vercel"), { recursive: true });
    await writeFile(
      join(projectRoot, ".vercel", "project.json"),
      JSON.stringify({ projectId: PROJECT_ID, orgId: "team_x" }),
      "utf8",
    );
  });

  afterEach(async () => {
    const vercelCommands = [
      ...mockedCaptureVercel.mock.calls,
      ...mockedRunVercel.mock.calls,
      ...mockedRunVercelCaptureStdout.mock.calls,
    ].map(([command]) => command);
    try {
      expect(vercelCommands.some((command) => command.includes("token"))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("reuses an existing connector for the service instead of creating one", async () => {
    // A connector for this service already exists in the team.
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: connectApiList("linear/existing", PROJECT_ID),
    });
    const log = createTestLog();

    const result = await setupConnectionConnector({
      log,
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
    });

    // Reused, not created: created is false and `connect create` never ran.
    expect(result).toEqual({ kind: "ready", created: false, connectorUid: "linear/existing" });
    // Connector setup is an operator action. The actual end user authorizes on
    // first use through Eve's interactive connection flow.
    expect(mockedCaptureVercel.mock.calls.map(([command]) => command[0])).toEqual(["api"]);
    expect(mockedRunVercel.mock.calls.map(([command]) => command[1])).toEqual(["attach"]);
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
    // The reused connector is still attached to this project.
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "attach", "linear/existing", "--yes"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(log.message).toHaveBeenCalledWith(expect.stringContaining("Reusing the existing"));
    expect(log.info).toHaveBeenCalledWith("Authorization is per user and starts on first use.");
  });

  test("does not reuse an attached connector that cannot authorize users", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          clients: [
            {
              uid: "linear/stale",
              id: "scl_stale",
              service: SERVICE,
              supportedSubjectTypes: [],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          clients: [
            {
              uid: "linear/current",
              id: "scl_current",
              service: SERVICE,
              supportedSubjectTypes: ["user"],
            },
          ],
        }),
      });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      principalType: "user",
      projectRoot,
      service: SERVICE,
      slug: "linear",
    });

    expect(result).toEqual({
      kind: "ready",
      created: false,
      connectorUid: "linear/current",
    });
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
  });

  test("requests a distinct name when only an incompatible connector already uses the slug", async () => {
    const incompatible = {
      uid: "mcp.linear.app/linear",
      id: "scl_stale",
      name: "linear",
      service: SERVICE,
      supportedSubjectTypes: [],
    };
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ clients: [incompatible] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ clients: [incompatible] }),
      });
    mockedRunVercelCaptureStdout.mockResolvedValueOnce({
      ok: true,
      stdout: createConnectorJson("mcp.linear.app/linear-rui-test"),
    });
    const selectConnector = vi.fn(async () => ({
      kind: "create" as const,
      name: "linear-rui-test",
    }));

    const result = await setupConnectionConnector({
      log: createTestLog(),
      principalType: "user",
      projectRoot,
      selectConnector,
      service: SERVICE,
      slug: "linear",
    });

    expect(selectConnector).toHaveBeenCalledWith({
      connectors: [],
      unavailableNames: ["linear"],
      scope: "team",
      service: SERVICE,
      slug: "linear",
      suggestedName: "linear-2",
    });
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledWith(
      ["connect", "create", SERVICE, "--name", "linear-rui-test", "-F", "json"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(result).toEqual({
      kind: "ready",
      created: true,
      connectorUid: "mcp.linear.app/linear-rui-test",
    });
  });

  test("exhausts connector-list pages before deciding whether to create", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ clients: [], cursor: "page-2" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: connectApiList("linear/existing-on-page-2", PROJECT_ID),
      });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
    });

    expect(result).toEqual({
      kind: "ready",
      created: false,
      connectorUid: "linear/existing-on-page-2",
    });
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      [
        "api",
        `/v1/connect/connectors?service=${SERVICE}&projectId=${PROJECT_ID}&cursor=page-2`,
        "--scope",
        "team_x",
        "--raw",
      ],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalledWith(
      expect.arrayContaining(["create"]),
      expect.anything(),
    );
  });

  test("falls back from the current project to an unambiguous team connector", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ clients: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: connectApiList("linear/team-existing", "prj_other"),
      });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
    });

    expect(result).toEqual({
      kind: "ready",
      created: false,
      connectorUid: "linear/team-existing",
    });
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      1,
      [
        "api",
        `/v1/connect/connectors?service=${SERVICE}&projectId=${PROJECT_ID}`,
        "--scope",
        "team_x",
        "--raw",
      ],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      [
        "api",
        `/v1/connect/connectors?service=${SERVICE}&include=projects`,
        "--scope",
        "team_x",
        "--raw",
      ],
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  test("reuses the explicitly selected team connector when several match", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ clients: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          clients: [
            { uid: "linear/team-a", id: "scl_a", supportedSubjectTypes: ["user"] },
            { uid: "linear/team-b", id: "scl_b", supportedSubjectTypes: ["user"] },
          ],
        }),
      });
    const selectConnector = vi.fn(async (request) => ({
      kind: "reuse" as const,
      connector: request.connectors[1]!,
    }));

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
      selectConnector,
    });

    expect(result).toEqual({
      kind: "ready",
      created: false,
      connectorUid: "linear/team-b",
    });
    expect(selectConnector).toHaveBeenCalledWith({
      connectors: [
        { uid: "linear/team-a", id: "scl_a" },
        { uid: "linear/team-b", id: "scl_b" },
      ],
      unavailableNames: ["team-a", "team-b"],
      scope: "team",
      service: SERVICE,
      slug: "linear",
      suggestedName: "linear",
    });
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalledWith(
      expect.arrayContaining(["create"]),
      expect.anything(),
    );
  });

  test("creates a new connector when the ambiguous team choice requests one", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ clients: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          clients: [
            { uid: "linear/team-a", id: "scl_a", supportedSubjectTypes: ["user"] },
            { uid: "linear/team-b", id: "scl_b", supportedSubjectTypes: ["user"] },
          ],
        }),
      });
    mockedRunVercelCaptureStdout.mockResolvedValueOnce({
      ok: true,
      stdout: createConnectorJson("linear/new"),
    });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
      selectConnector: async () => ({ kind: "create", name: "linear-rui-test" }),
    });

    expect(result).toEqual({
      kind: "ready",
      created: true,
      connectorUid: "linear/new",
    });
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledWith(
      ["connect", "create", SERVICE, "--name", "linear-rui-test", "-F", "json"],
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  test("does not choose again when create returns no exact connector identifier", async () => {
    mockedCaptureVercel.mockImplementation(async (command) => ({
      ok: true,
      stdout: JSON.stringify(
        command[1]?.includes("projectId=")
          ? { clients: [] }
          : {
              clients: [
                { uid: "linear/team-a", id: "scl_a", supportedSubjectTypes: ["user"] },
                { uid: "linear/team-b", id: "scl_b", supportedSubjectTypes: ["user"] },
              ],
            },
      ),
    }));
    mockedRunVercelCaptureStdout.mockResolvedValueOnce({ ok: true, stdout: "" });
    const selectConnector = vi.fn(async () => ({
      kind: "create" as const,
      name: "linear-rui-test",
    }));

    await expect(
      setupConnectionConnector({
        log: createTestLog(),
        principalType: "user",
        projectRoot,
        service: SERVICE,
        slug: "linear",
        selectConnector,
      }),
    ).rejects.toThrow(/connector identifier/i);

    expect(selectConnector).toHaveBeenCalledOnce();
  });

  test("resolves the UID from `connect create -F json` without a follow-up list", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createConnectorJson("linear/my-agent"),
    });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
    });

    expect(result).toEqual({ kind: "ready", created: true, connectorUid: "linear/my-agent" });

    // Created with the catalog service identifier, slug name, and JSON output.
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledWith(
      ["connect", "create", SERVICE, "--name", "linear", "-F", "json"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    // The project-scoped and team-scoped reuse lookups both run before create.
    // The authoritative create payload makes a post-create lookup unnecessary.
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
    // The connector is attached to the linked project so the agent can call it.
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "attach", "linear/my-agent", "--yes"],
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  test("fails when attaching the connector to the project fails", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createConnectorJson("linear/my-agent"),
    });
    mockedRunVercel.mockResolvedValue(false);
    const log = createTestLog();

    await expect(
      setupConnectionConnector({
        log,
        projectRoot,
        slug: "linear",
        service: SERVICE,
        principalType: "user",
      }),
    ).rejects.toThrow(/could not attach/i);
  });

  test("reuses the remote connector when retrying after attachment failed", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValueOnce({
      ok: true,
      stdout: createConnectorJson("linear/created-once"),
    });
    mockedRunVercel.mockResolvedValueOnce(false);

    await expect(
      setupConnectionConnector({
        log: createTestLog(),
        projectRoot,
        slug: "linear",
        service: SERVICE,
        principalType: "user",
      }),
    ).rejects.toThrow(/attach/i);

    mockedCaptureVercel.mockReset();
    mockedCaptureVercel.mockResolvedValue({
      ok: true,
      stdout: connectApiList("linear/created-once", PROJECT_ID),
    });
    mockedRunVercel.mockResolvedValue(true);

    const retried = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
    });

    expect(retried).toEqual({
      kind: "ready",
      created: false,
      connectorUid: "linear/created-once",
    });
    expect(mockedCaptureVercel).toHaveBeenCalledOnce();
    expect(mockedRunVercelCaptureStdout).toHaveBeenCalledTimes(1);
  });

  test("surfaces the Vercel setup diagnostic when create fails", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr:
        "\u001B[31mError: Setup failed: This connector does not support user authorization (unsupported_subject)\u001B[39m\n",
      failure: "exit",
    });

    await expect(
      setupConnectionConnector({
        log: createTestLog(),
        projectRoot,
        slug: "linear",
        service: SERVICE,
        principalType: "user",
      }),
    ).rejects.toThrow(
      "Could not create the mcp.linear.app connector: Setup failed: This connector does not support user authorization (unsupported_subject)",
    );
    // Both pre-create reuse scopes ran; create failed before any post-create list.
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
  });

  test("continues with the exact connector created before the CLI exits nonzero", async () => {
    mockedRunVercelCaptureStdout.mockImplementationOnce(async (_args, options) => {
      options.onOutput?.({
        stream: "stderr",
        text: "> Connector created: scl_partial",
      });
      return { ok: false, stdout: "", stderr: "", failure: "exit" };
    });
    mockedCaptureVercel
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ clients: [] }) })
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ clients: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          uid: "linear/partial",
          id: "scl_partial",
          service: SERVICE,
          supportedSubjectTypes: ["user"],
        }),
      });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
    });

    expect(result).toEqual({
      kind: "ready",
      created: true,
      connectorUid: "linear/partial",
    });
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      3,
      ["api", "/v1/connect/connectors/scl_partial", "--scope", "team_x", "--raw"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "attach", "linear/partial", "--yes"],
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  test("uses create JSON even when the CLI exits nonzero after creation", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValueOnce({
      ok: false,
      stdout: createConnectorJson("linear/created", "scl_created"),
      stderr: "",
      failure: "exit",
    });

    const result = await setupConnectionConnector({
      log: createTestLog(),
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
    });

    expect(result).toEqual({
      kind: "ready",
      created: true,
      connectorUid: "linear/created",
    });
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "attach", "linear/created", "--yes"],
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  test("links a Vercel project when none is linked yet, then attaches", async () => {
    // Start unlinked: the gateway step used an API key/local provider, or this
    // is a fresh `eve connections add` checkout.
    await rm(join(projectRoot, ".vercel", "project.json"), { force: true });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createConnectorJson("linear/my-agent"),
    });
    // `vercel link` writes `.vercel/project.json`; everything else succeeds.
    mockedRunVercel.mockImplementation(async (args) => {
      if (args[0] === "link") {
        await writeFile(
          join(projectRoot, ".vercel", "project.json"),
          JSON.stringify({ projectId: PROJECT_ID, orgId: "team_x" }),
          "utf8",
        );
      }
      return true;
    });
    const log = createTestLog();

    const result = await setupConnectionConnector({
      log,
      projectRoot,
      slug: "linear",
      service: SERVICE,
      principalType: "user",
    });

    expect(result).toEqual({ kind: "ready", created: true, connectorUid: "linear/my-agent" });
    // Linked first, then attached to the now-linked project.
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["link"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(mockedRunVercel).toHaveBeenCalledWith(
      ["connect", "attach", "linear/my-agent", "--yes"],
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  test("fails before connector creation when linking does not complete", async () => {
    await rm(join(projectRoot, ".vercel", "project.json"), { force: true });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: createConnectorJson("linear/my-agent"),
    });
    // `vercel link` is declined/fails, so no project.json is written.
    mockedRunVercel.mockResolvedValue(false);
    mockedCaptureVercel.mockResolvedValue({ ok: true, stdout: JSON.stringify({ clients: [] }) });
    const log = createTestLog();

    await expect(
      setupConnectionConnector({
        log,
        projectRoot,
        slug: "linear",
        service: SERVICE,
        principalType: "user",
      }),
    ).rejects.toThrow(/linked Vercel project/i);

    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
  });

  test("fails safely when create returns no connector identifier", async () => {
    mockedRunVercelCaptureStdout.mockResolvedValue({ ok: true, stdout: "" });
    mockedCaptureVercel.mockResolvedValue({ ok: true, stdout: JSON.stringify({ clients: [] }) });

    await expect(
      setupConnectionConnector({
        log: createTestLog(),
        projectRoot,
        slug: "linear",
        service: SERVICE,
        principalType: "user",
      }),
    ).rejects.toThrow(/connector identifier/i);
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(2);
  });
});
