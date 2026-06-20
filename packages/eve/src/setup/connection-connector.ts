import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { createPromptCommandOutput, type ChannelSetupLog } from "#setup/cli/index.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

/** Controls connector provisioning while adding a Connect-backed connection. */
export interface SetupConnectionConnectorOptions {
  /** Status and command output stream through this log (rail styling preserved). */
  log: ChannelSetupLog;
  projectRoot: string;
  /** Authored connection slug, used as the initial connector-name suggestion. */
  slug: string;
  /** `vercel connect create <service>` identifier (e.g. `mcp.linear.app`). */
  service: string;
  /** Principal mode emitted by the generated `connect(...)` definition. */
  principalType: "user";
  /** Cancels browser connector setup and every supporting Vercel CLI subprocess. */
  signal?: AbortSignal;
  /**
   * Links a Vercel project before Connect provisioning when the caller owns a
   * richer linking flow (e.g. shared team selection). Returns the linked
   * project id, or `undefined` when linking did not complete. When omitted,
   * falls back to a bare `vercel link`.
   */
  linkProject?: () => Promise<string | undefined>;
  /** Resolves reuse ambiguity and gathers the name for a newly created connector. */
  selectConnector?: (request: ConnectConnectorChoiceRequest) => Promise<ConnectConnectorChoice>;
}

/**
 * Outcome of resolving and attaching a Connect connector.
 * `created` distinguishes a freshly minted connector from a reused existing
 * one (the flow prefers reuse), so callers can phrase follow-ups accordingly.
 */
export type SetupConnectionConnectorResult = {
  kind: "ready";
  created: boolean;
  connectorUid: string;
};

const CONNECT_LOOKUP_TIMEOUT_MS = 60_000;
const CONNECT_MUTATION_TIMEOUT_MS = 2 * 60_000;
const CONNECT_CREATE_TIMEOUT_MS = 30 * 60_000;
const CREATED_CONNECTOR_PROGRESS = /^> Connector created: (\S+)$/;

function vercelErrorDiagnostic(stderr: string): string | undefined {
  const lines = stripVTControlCharacters(stderr)
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.startsWith("Error: ")) return line.slice("Error: ".length);
    if (line.startsWith("Setup failed: ")) return line;
  }
  return undefined;
}

interface VercelConnectListClient {
  uid?: unknown;
  id?: unknown;
  name?: unknown;
  service?: unknown;
  supportedSubjectTypes?: unknown;
  includes?: unknown;
}

interface VercelConnectListResponse {
  clients?: unknown;
  cursor?: unknown;
}

interface VercelProjectLink {
  projectId: string;
  orgId: string;
}

/** Identifiers returned by Vercel Connect for a connector. */
export interface ConnectConnectorRef {
  uid: string;
  id: string;
}

/** The ambiguous connector set presented to an interactive setup caller. */
export interface ConnectConnectorChoiceRequest {
  connectors: readonly ConnectConnectorRef[];
  /** Connector names already reserved for this service in the current team. */
  unavailableNames: readonly string[];
  scope: "project" | "team";
  service: string;
  slug: string;
  /** Free connector name suggested from the current team inventory. */
  suggestedName: string;
}

/** Explicit resolution for an ambiguous connector set. */
export type ConnectConnectorChoice =
  | { kind: "reuse"; connector: ConnectConnectorRef }
  | { kind: "create"; name: string };

/** Result of selecting one service connector from a validated list response. */
export type ConnectConnectorSelection =
  | { kind: "found"; connector: ConnectConnectorRef }
  | { kind: "not-found" }
  | { kind: "ambiguous"; connectors: readonly ConnectConnectorRef[] }
  | { kind: "invalid" };

/**
 * Reads the connector identifiers from `vercel connect create … -F json`
 * stdout. This is the authoritative source for the just-created connector's
 * UID — it avoids a follow-up list request, which can momentarily 404/rate
 * limit right after creation and cannot disambiguate when a service already
 * has multiple connectors. Returns `undefined` when stdout is empty or not the
 * expected JSON, or when the created connector does not support the principal
 * mode that the generated connection will request.
 */
export function parseCreatedConnector(
  stdout: string,
  principalType: SetupConnectionConnectorOptions["principalType"],
): ConnectConnectorRef | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { uid, id, supportedSubjectTypes } = parsed as {
    uid?: unknown;
    id?: unknown;
    supportedSubjectTypes?: unknown;
  };
  if (typeof uid !== "string" || typeof id !== "string") return undefined;
  if (!Array.isArray(supportedSubjectTypes) || !supportedSubjectTypes.includes(principalType)) {
    return undefined;
  }
  return { uid, id };
}

function attachedToProject(raw: VercelConnectListClient, projectId: string | undefined): boolean {
  if (projectId === undefined) return false;
  if (typeof raw.includes !== "object" || raw.includes === null) return false;
  const projects = (raw.includes as { projects?: unknown }).projects;
  if (typeof projects !== "object" || projects === null) return false;
  const items = (projects as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  return items.some(
    (project) =>
      typeof project === "object" &&
      project !== null &&
      (project as { projectId?: unknown }).projectId === projectId,
  );
}

/**
 * Finds a connector that supports the generated connection's principal mode.
 * The list is expected to be scoped to the requested service server-side;
 * reported service mismatches and unsupported subject modes are still skipped
 * defensively. Selection must be unambiguous: exactly one connector attached
 * to this project, or exactly one candidate across the team.
 */
export function pickConnectConnector(
  listJson: unknown,
  service: string,
  principalType: SetupConnectionConnectorOptions["principalType"],
  projectId?: string,
): ConnectConnectorSelection {
  if (typeof listJson !== "object" || listJson === null) return { kind: "invalid" };
  const response = listJson as VercelConnectListResponse;
  const connectors = response.clients;
  if (!Array.isArray(connectors)) return { kind: "invalid" };

  const candidates: Array<{ ref: ConnectConnectorRef; attached: boolean }> = [];

  for (const raw of connectors as VercelConnectListClient[]) {
    if (typeof raw.service === "string" && raw.service !== service) continue;
    if (typeof raw.uid !== "string" || typeof raw.id !== "string") continue;
    if (
      !Array.isArray(raw.supportedSubjectTypes) ||
      !raw.supportedSubjectTypes.includes(principalType)
    ) {
      continue;
    }

    const ref: ConnectConnectorRef = { uid: raw.uid, id: raw.id };
    candidates.push({ ref, attached: attachedToProject(raw, projectId) });
  }

  const attached = candidates.filter((candidate) => candidate.attached);
  if (attached.length === 1) return { kind: "found", connector: attached[0]!.ref };
  if (attached.length > 1) {
    return { kind: "ambiguous", connectors: attached.map((candidate) => candidate.ref) };
  }
  if (candidates.length === 1) return { kind: "found", connector: candidates[0]!.ref };
  if (candidates.length > 1) {
    return { kind: "ambiguous", connectors: candidates.map((candidate) => candidate.ref) };
  }
  return { kind: "not-found" };
}

function connectorNames(connectors: readonly VercelConnectListClient[]): string[] {
  const namesByNormalizedName = new Map<string, string>();
  for (const connector of connectors) {
    if (typeof connector.name === "string" && connector.name.trim().length > 0) {
      const name = connector.name.trim();
      namesByNormalizedName.set(name.toLowerCase(), name);
    }
    if (typeof connector.uid === "string") {
      const separator = connector.uid.lastIndexOf("/");
      const uidName = connector.uid.slice(separator + 1).trim();
      if (uidName.length > 0 && !namesByNormalizedName.has(uidName.toLowerCase())) {
        namesByNormalizedName.set(uidName.toLowerCase(), uidName);
      }
    }
  }
  return [...namesByNormalizedName.values()];
}

function suggestedConnectorName(slug: string, unavailableNames: readonly string[]): string {
  const normalizedNames = new Set(unavailableNames.map((name) => name.toLowerCase()));
  if (!normalizedNames.has(slug.toLowerCase())) return slug;
  let suffix = 2;
  while (normalizedNames.has(`${slug}-${suffix}`.toLowerCase())) suffix += 1;
  return `${slug}-${suffix}`;
}

async function readProjectLink(projectRoot: string): Promise<VercelProjectLink | undefined> {
  try {
    const raw = await readFile(join(projectRoot, ".vercel", "project.json"), "utf8");
    const parsed = JSON.parse(raw) as { projectId?: unknown; orgId?: unknown };
    if (typeof parsed.projectId !== "string" || typeof parsed.orgId !== "string") {
      return undefined;
    }
    return { projectId: parsed.projectId, orgId: parsed.orgId };
  } catch {
    return undefined;
  }
}

/**
 * Connect attach requires a linked Vercel project. The connection step can run
 * before one exists — the gateway step used an API key or a local provider, or
 * `eve connections add` ran in a fresh checkout — so link one first. Returns the
 * resolved project id, or `undefined` when linking did not complete.
 */
async function ensureLinkedProject(
  log: ChannelSetupLog,
  projectRoot: string,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const existing = await readProjectLink(projectRoot);
  if (existing) return existing.projectId;
  log.message("Linking a Vercel project for Connect...");
  await runVercel(["link"], {
    cwd: projectRoot,
    onOutput,
    signal,
    timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
  });
  return (await readProjectLink(projectRoot))?.projectId;
}

async function listConnectors(
  projectRoot: string,
  project: VercelProjectLink,
  service: string,
  allProjects: boolean,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  signal: AbortSignal | undefined,
): Promise<VercelConnectListClient[]> {
  // `vercel connect list -F json` omits `supportedSubjectTypes`. Query the
  // same API through the authenticated CLI so incompatible legacy connectors
  // cannot be reused for a generated user-scoped connection.
  const connectors: VercelConnectListClient[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ service });
    if (allProjects) query.set("include", "projects");
    else query.set("projectId", project.projectId);
    if (cursor !== undefined) query.set("cursor", cursor);
    const endpoint = `/v1/connect/connectors?${query.toString()}`;
    const args = ["api", endpoint, "--scope", project.orgId, "--raw"];
    const result = await captureVercel(args, {
      cwd: projectRoot,
      onOutput,
      signal,
      timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
    });
    if (!result.ok) {
      throw new Error(`Could not list existing ${service} connectors: ${result.failure.message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Could not parse the connector list returned for ${service}.`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`The connector list returned an invalid payload for ${service}.`);
    }
    const page = parsed as VercelConnectListResponse;
    const pageConnectors = page.clients;
    if (!Array.isArray(pageConnectors)) {
      throw new Error(`The connector list returned an invalid payload for ${service}.`);
    }
    connectors.push(...(pageConnectors as VercelConnectListClient[]));

    const nextCursor = typeof page.cursor === "string" && page.cursor ? page.cursor : undefined;
    if (nextCursor !== undefined && seenCursors.has(nextCursor)) {
      throw new Error(`The connector list repeated cursor ${nextCursor} for ${service}.`);
    }
    if (nextCursor !== undefined) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== undefined);

  return connectors;
}

async function findConnector(
  projectRoot: string,
  project: VercelProjectLink,
  slug: string,
  service: string,
  principalType: SetupConnectionConnectorOptions["principalType"],
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  signal: AbortSignal | undefined,
  selectConnector: SetupConnectionConnectorOptions["selectConnector"],
): Promise<ConnectConnectorChoice> {
  const projectConnectors = await listConnectors(
    projectRoot,
    project,
    service,
    false,
    onOutput,
    signal,
  );
  const projectSelection = pickConnectConnector(
    { clients: projectConnectors },
    service,
    principalType,
  );
  if (projectSelection.kind === "found") {
    return { kind: "reuse", connector: projectSelection.connector };
  }
  if (projectSelection.kind === "ambiguous") {
    if (selectConnector === undefined) {
      throw new Error(
        `Multiple ${service} connectors are attached to this project: ${projectSelection.connectors
          .map((connector) => connector.uid)
          .join(", ")}. Select one interactively or configure the connection file explicitly.`,
      );
    }
    const teamConnectors = await listConnectors(
      projectRoot,
      project,
      service,
      true,
      onOutput,
      signal,
    );
    const unavailableNames = connectorNames(teamConnectors);
    return selectConnector({
      connectors: projectSelection.connectors,
      unavailableNames,
      scope: "project",
      service,
      slug,
      suggestedName: suggestedConnectorName(slug, unavailableNames),
    });
  }
  if (projectSelection.kind === "invalid") {
    throw new Error(`The project connector list returned an invalid payload for ${service}.`);
  }

  const teamConnectors = await listConnectors(
    projectRoot,
    project,
    service,
    true,
    onOutput,
    signal,
  );
  const selection = pickConnectConnector(
    { clients: teamConnectors },
    service,
    principalType,
    project.projectId,
  );
  switch (selection.kind) {
    case "found":
      return { kind: "reuse", connector: selection.connector };
    case "not-found": {
      const unavailableNames = connectorNames(teamConnectors);
      const request: ConnectConnectorChoiceRequest = {
        connectors: [],
        unavailableNames,
        scope: "team",
        service,
        slug,
        suggestedName: suggestedConnectorName(slug, unavailableNames),
      };
      return selectConnector === undefined
        ? { kind: "create", name: request.suggestedName }
        : selectConnector(request);
    }
    case "ambiguous": {
      if (selectConnector === undefined) {
        throw new Error(
          `Multiple ${service} connectors are available across the team: ${selection.connectors
            .map((connector) => connector.uid)
            .join(", ")}. Select one interactively or configure the connection file explicitly.`,
        );
      }
      const unavailableNames = connectorNames(teamConnectors);
      return selectConnector({
        connectors: selection.connectors,
        unavailableNames,
        scope: "team",
        service,
        slug,
        suggestedName: suggestedConnectorName(slug, unavailableNames),
      });
    }
    case "invalid":
      throw new Error(`The connector list returned an invalid payload for ${service}.`);
  }
}

async function findConnectorById(
  projectRoot: string,
  project: VercelProjectLink,
  service: string,
  principalType: SetupConnectionConnectorOptions["principalType"],
  connectorId: string,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  signal: AbortSignal | undefined,
): Promise<ConnectConnectorRef | undefined> {
  const endpoint = `/v1/connect/connectors/${encodeURIComponent(connectorId)}`;
  const result = await captureVercel(["api", endpoint, "--scope", project.orgId, "--raw"], {
    cwd: projectRoot,
    onOutput,
    signal,
    timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
  });
  if (!result.ok) {
    throw new Error(`Could not verify connector ${connectorId}: ${result.failure.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Could not parse connector ${connectorId} returned by Vercel Connect.`);
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const connector = parsed as VercelConnectListClient;
  if (connector.id !== connectorId || typeof connector.uid !== "string") return undefined;
  if (typeof connector.service === "string" && connector.service !== service) return undefined;
  if (
    !Array.isArray(connector.supportedSubjectTypes) ||
    !connector.supportedSubjectTypes.includes(principalType)
  ) {
    throw new Error(
      `Connector ${connectorId} does not support ${principalType} authorization required by ${service}.`,
    );
  }
  return { id: connectorId, uid: connector.uid };
}

/**
 * Resolves and attaches a Vercel Connect connector. The flow reuses an
 * unambiguous existing connector for the service; multiple candidates require
 * an explicit choice. End-user authorization is intentionally deferred to the
 * connection runtime, which owns the actual user principal and drives its
 * interactive authorization flow.
 */
export async function setupConnectionConnector(
  options: SetupConnectionConnectorOptions,
): Promise<SetupConnectionConnectorResult> {
  const { log, principalType, projectRoot, signal, slug, service } = options;
  const onOutput = createPromptCommandOutput(log);

  const projectId = options.linkProject
    ? await options.linkProject()
    : await ensureLinkedProject(log, projectRoot, onOutput, signal);
  if (projectId === undefined) {
    throw new Error(
      `A linked Vercel project is required before configuring ${slug}. Run \`vercel link\` and retry.`,
    );
  }
  const project = await readProjectLink(projectRoot);
  if (project === undefined || project.projectId !== projectId) {
    throw new Error(
      `The linked Vercel project metadata for ${slug} is incomplete. Run \`vercel link\` and retry.`,
    );
  }

  const choice = await findConnector(
    projectRoot,
    project,
    slug,
    service,
    principalType,
    onOutput,
    signal,
    options.selectConnector,
  );
  let ref: ConnectConnectorRef;
  let created = false;
  if (choice.kind === "reuse") {
    ref = choice.connector;
    log.message(`Reusing the existing ${service} connector ${ref.uid}.`);
  } else {
    const connectorName = choice.name.trim();
    if (connectorName.length === 0) throw new Error("Connector name cannot be empty.");
    log.message(`Connecting ${slug} via Vercel Connect...`);
    let createdConnectorId: string | undefined;
    const createOutput: typeof onOutput = (line) => {
      onOutput(line);
      const connectorId = CREATED_CONNECTOR_PROGRESS.exec(line.text)?.[1];
      if (connectorId === undefined || createdConnectorId !== undefined) return;
      createdConnectorId = connectorId;
    };
    const create = await runVercelCaptureStdout(
      ["connect", "create", service, "--name", connectorName, "-F", "json"],
      {
        cwd: projectRoot,
        onOutput: createOutput,
        signal,
        timeoutMs: CONNECT_CREATE_TIMEOUT_MS,
      },
    );
    const createdRef =
      parseCreatedConnector(create.stdout, principalType) ??
      (createdConnectorId === undefined
        ? undefined
        : await findConnectorById(
            projectRoot,
            project,
            service,
            principalType,
            createdConnectorId,
            onOutput,
            signal,
          ));
    if (createdConnectorId !== undefined && createdRef === undefined) {
      throw new Error(
        `Connector ${createdConnectorId} was created for ${slug} but is not visible yet. Retry /connect after it becomes visible.`,
      );
    }
    if (!create.ok && createdRef === undefined) {
      signal?.throwIfAborted();
      switch (create.failure) {
        case "exit": {
          const diagnostic = vercelErrorDiagnostic(create.stderr);
          throw new Error(
            diagnostic === undefined
              ? `Could not create the ${service} connector because Vercel CLI exited before returning a connector. Review the command output above.`
              : `Could not create the ${service} connector: ${diagnostic}`,
          );
        }
        case "timeout":
          throw new Error(
            `Creating the ${service} connector timed out before browser setup completed.`,
          );
        case "spawn":
          throw new Error(`Could not start Vercel CLI to create the ${service} connector.`);
        case "aborted":
          throw new Error(`Creating the ${service} connector was aborted.`);
      }
    }
    if (createdRef === undefined) {
      throw new Error(
        `The ${service} connector was created, but Vercel CLI did not return a usable connector identifier. Retry /connect after updating Vercel CLI.`,
      );
    }
    created = true;
    ref = createdRef;
  }

  const attached = await runVercel(["connect", "attach", ref.uid, "--yes"], {
    cwd: projectRoot,
    onOutput,
    signal,
    timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
  });
  if (!attached) {
    throw new Error(
      `Could not attach ${ref.uid} to the linked Vercel project. Retry /connect after checking project access.`,
    );
  }

  log.success(`Attached ${ref.uid}`);
  log.info("Authorization is per user and starts on first use.");
  return { kind: "ready", created, connectorUid: ref.uid };
}
