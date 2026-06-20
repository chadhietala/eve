import {
  ensureConnection,
  ensureConnectionDependencies,
  listAuthoredConnections,
  type ConnectionInput,
  type ConnectionMutationResult,
} from "#setup/scaffold/index.js";
import { createPromptCommandOutput, type ChannelSetupLog, withPhase } from "#setup/cli/index.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { runPackageManagerInstall } from "#setup/primitives/pm/run.js";
import { updateConnectionConnectorUid } from "#setup/scaffold/update/update-connection-connector.js";

import {
  setupConnectionConnector,
  type ConnectConnectorChoice,
  type ConnectConnectorChoiceRequest,
} from "../connection-connector.js";
import {
  isProjectResolved,
  mergeProjectResolution,
  type ProjectResolution,
} from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { hasVercelProject, requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";
import { projectIdFromResolution } from "../vercel-project.js";
import { CONNECT_REQUIRES_VERCEL } from "./select-connections.js";

/** Injected for tests; defaults to the real scaffold and Connect effects. */
export interface AddConnectionsDeps {
  detectPackageManager: typeof detectPackageManager;
  ensureConnection: typeof ensureConnection;
  ensureConnectionDependencies: typeof ensureConnectionDependencies;
  listAuthoredConnections: typeof listAuthoredConnections;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  setupConnectionConnector: typeof setupConnectionConnector;
  updateConnectionConnectorUid: typeof updateConnectionConnectorUid;
}

function withConnectorUid(entry: ConnectionInput, connectorUid: string): ConnectionInput {
  if (entry.auth?.kind !== "connect") {
    throw new Error(`Connection ${entry.slug} is not configured for Vercel Connect.`);
  }
  return { ...entry, auth: { ...entry.auth, connector: connectorUid } };
}

export interface AddConnectionsOptions {
  /** Carries connector choices, creation-name input, and provisioning output. */
  prompter: Prompter;
  /** Resume remote provisioning when `/connect` selected an existing placeholder file. */
  provisionExistingConnect?: boolean;
  signal?: AbortSignal;
  deps?: AddConnectionsDeps;
}

function logFollowUp(log: ChannelSetupLog, result: ConnectionMutationResult): void {
  if (result.action === "skipped") {
    log.warning(`Skipped ${result.slug} (already exists; pass --force to overwrite).`);
    return;
  }
  log.success(`Added agent/connections/${result.slug}.ts`);
  if (result.envKeysAdded.length > 0) {
    log.info(`Set ${result.envKeysAdded.join(", ")} in .env.local`);
  } else if (result.envKeysRequired.length > 0) {
    log.info(`Set ${result.envKeysRequired.join(", ")} in your environment`);
  }
}

async function selectConnectConnector(
  prompter: Prompter,
  request: ConnectConnectorChoiceRequest,
): Promise<ConnectConnectorChoice> {
  const createConnector = async (): Promise<ConnectConnectorChoice> => {
    const unavailableNames = new Set(
      request.unavailableNames.map((name) => name.trim().toLowerCase()),
    );
    const textOptions: Parameters<Prompter["text"]>[0] = {
      message: "New connector name",
      defaultValue: request.suggestedName,
      validate: (value) => {
        const name = value.trim();
        if (name.length === 0) return "Connector name cannot be empty.";
        if (unavailableNames.has(name.toLowerCase())) {
          return `Connector name "${name}" already exists.`;
        }
        return undefined;
      },
    };
    if (request.suggestedName !== request.slug) {
      textOptions.notices = [
        {
          tone: "warning",
          text: `Connector named "${request.slug}" already exists.`,
        },
      ];
    }
    const name = (await prompter.text(textOptions)).trim();
    return { kind: "create", name };
  };

  if (request.connectors.length === 0) return createConnector();

  const createValue = "create";
  const reuseValue = (index: number) => `reuse:${index}`;
  const selected = await prompter.select<string>({
    message: `Which connector should ${request.slug} use?`,
    search: true,
    placeholder: "type to search connectors",
    options: [
      ...request.connectors.map((connector, index) => ({
        value: reuseValue(index),
        label: connector.uid,
        hint: connector.id,
      })),
      {
        value: createValue,
        label: "Create a new connector",
        hint: `Register another ${request.service} connector`,
      },
    ],
  });
  if (selected === createValue) return createConnector();

  const index = Number(selected.slice("reuse:".length));
  const connector = request.connectors[index];
  if (connector === undefined) {
    throw new Error(`Connector selection ${selected} is no longer available.`);
  }
  return { kind: "reuse", connector };
}

/**
 * THE CONNECTIONS BOX: executes the {@link ConnectionPlan}s the
 * select-connections box recorded during the interview. Connector reuse and
 * creation details are resolved here because they depend on live Connect
 * inventory; the remaining work is file scaffolding and provisioning.
 */
export function addConnections(
  options: AddConnectionsOptions,
): SetupBox<SetupState, null, ProjectResolution> {
  const deps = options.deps ?? {
    detectPackageManager,
    ensureConnection,
    ensureConnectionDependencies,
    listAuthoredConnections,
    runPackageManagerInstall,
    setupConnectionConnector,
    updateConnectionConnectorUid,
  };

  return {
    id: "add-connections",

    shouldRun(state) {
      return state.connectionSelection.length > 0;
    },

    async gather(): Promise<null> {
      return null;
    },

    async perform({ state }): Promise<ProjectResolution> {
      const log = options.prompter.log;
      const projectRoot = requireProjectPath(state);
      const noVercel = !hasVercelProject(state);
      const project = state.project;

      for (const plan of state.connectionSelection) {
        const existingConnection = (await deps.listAuthoredConnections(projectRoot)).includes(
          plan.slug,
        );
        if (existingConnection && options.provisionExistingConnect !== true) {
          const result = await deps.ensureConnection({
            projectRoot,
            slug: plan.slug,
            protocol: plan.protocol,
            entry: plan.entry,
          });
          logFollowUp(log, result);
          continue;
        }

        let entry = plan.entry;
        let connectorUid: string | undefined;
        if (plan.provision.kind === "connect") {
          if (plan.entry.auth?.kind !== "connect") {
            throw new Error(`Connection ${plan.slug} has no Connect authorization definition.`);
          }
          const connector = await deps.setupConnectionConnector({
            log,
            principalType: plan.entry.auth.principalType,
            projectRoot,
            slug: plan.slug,
            service: plan.provision.service,
            signal: options.signal,
            selectConnector: (request) => selectConnectConnector(options.prompter, request),
            // The project was linked up front by the link box; Connect
            // provisioning reuses it. The link box is a hard invariant once
            // Vercel is in play: an unresolved project here means it did not
            // run or did not record a resolution.
            linkProject: async () => {
              if (noVercel) {
                throw new Error(CONNECT_REQUIRES_VERCEL);
              }
              if (!isProjectResolved(project)) {
                throw new Error(
                  "Expected a linked Vercel project for Connect, but none was resolved.",
                );
              }
              return projectIdFromResolution(project);
            },
          });
          connectorUid = connector.connectorUid;
          entry = withConnectorUid(plan.entry, connectorUid);
          await deps.ensureConnectionDependencies({ projectRoot, entry });
          const packageManager = await deps.detectPackageManager(projectRoot);
          const installed = await withPhase(
            log,
            `Installing connection dependencies (${packageManager.kind} install)...`,
            () =>
              deps.runPackageManagerInstall(packageManager.kind, projectRoot, {
                onOutput: createPromptCommandOutput(log),
                signal: options.signal,
              }),
          );
          if (!installed) {
            throw new Error(
              `Dependency installation failed. Run \`${packageManager.kind} install\`, then retry /connect.`,
            );
          }
        }

        const result = await deps.ensureConnection({
          projectRoot,
          slug: plan.slug,
          protocol: plan.protocol,
          entry,
        });
        const resumeExistingConnect =
          result.action === "skipped" &&
          options.provisionExistingConnect === true &&
          plan.provision.kind === "connect";
        if (resumeExistingConnect) {
          if (connectorUid === undefined) {
            throw new Error(`Connect provisioning for ${result.slug} returned no connector UID.`);
          }
          log.info(`Resuming setup for agent/connections/${result.slug}.ts`);
          const { patched } = await deps.updateConnectionConnectorUid(
            result.filePath,
            connectorUid,
          );
          if (!patched) {
            throw new Error(
              `Connector ${connectorUid} is ready, but ${result.filePath} has no patchable \`connect("…")\` call.`,
            );
          }
        } else {
          logFollowUp(log, result);
        }
        if (result.action === "skipped" && !resumeExistingConnect) continue;

        switch (plan.provision.kind) {
          case "connect":
            break;
          case "command-hint":
            log.info(
              `Run \`vercel connect create ${plan.provision.service} --name ${result.slug}\`, then set the connector UID in agent/connections/${result.slug}.ts.`,
            );
            break;
          case "connect-manual":
            log.warning(
              `Could not determine a Connect service for ${result.slug}. Create the connector manually and set its UID in agent/connections/${result.slug}.ts.`,
            );
            break;
          case "none":
            break;
        }
      }
      return project;
    },

    apply(state, payload) {
      return { ...state, project: mergeProjectResolution(state.project, payload) };
    },
  };
}
