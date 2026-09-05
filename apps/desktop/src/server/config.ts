import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One agent the desktop can talk to. */
export interface BotConfig {
  /** Optional accent used for the bot's avatar, as a hex color. */
  readonly color?: string;
  readonly description?: string;
  /** Sidebar group, e.g. "Work". Ungrouped bots sort first. */
  readonly group?: string;
  readonly id: string;
  readonly name: string;
  readonly pinned?: boolean;
  /** Bearer token forwarded to the agent, never sent to the renderer. */
  readonly token?: string;
  /** One-line role shown under the name, e.g. "Release manager". */
  readonly title?: string;
  /** Base URL of the eve agent, e.g. `https://agent.example.com`. */
  readonly url: string;
}

export interface DesktopConfig {
  readonly bots: readonly BotConfig[];
  /** Shared secret for this desktop's control server and computer host. */
  readonly controlToken: string;
}

/** A bot as the renderer sees it: no credentials. */
export type PublicBot = Omit<BotConfig, "token"> & { readonly hasToken: boolean };

export function toPublicBot(bot: BotConfig): PublicBot {
  const { token, ...rest } = bot;
  return { ...rest, hasToken: token !== undefined && token.length > 0 };
}

export function configPath(): string {
  const base = process.env.EVE_DESKTOP_CONFIG;
  if (base !== undefined && base.length > 0) return base;
  return join(homedir(), ".eve", "desktop", "config.json");
}

/**
 * Reads the desktop's configuration, creating it on first run.
 *
 * The control token is generated here rather than asked for: the desktop
 * hosts a computer, so it must be authenticated from the first request, and a
 * setup step a person can skip is a setup step that gets skipped.
 */
export async function loadConfig(path = configPath()): Promise<DesktopConfig> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (raw === null) {
    const created: DesktopConfig = {
      bots: [],
      controlToken: randomBytes(24).toString("base64url"),
    };
    await saveConfig(created, path);
    return created;
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError(`${path} is not a desktop configuration object.`);
  }
  const config = parsed as Partial<DesktopConfig>;
  const controlToken =
    typeof config.controlToken === "string" && config.controlToken.length >= 16
      ? config.controlToken
      : randomBytes(24).toString("base64url");
  const bots = Array.isArray(config.bots) ? config.bots.filter(isBotConfig) : [];
  return { bots, controlToken };
}

export async function saveConfig(config: DesktopConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Write through a sibling so a crash mid-write cannot leave a truncated
  // config — which would regenerate the control token and unpair the phone.
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function isBotConfig(value: unknown): value is BotConfig {
  if (typeof value !== "object" || value === null) return false;
  const bot = value as Partial<BotConfig>;
  return typeof bot.id === "string" && typeof bot.name === "string" && typeof bot.url === "string";
}

/** Validates and normalizes bot fields arriving from the renderer. */
export function normalizeBotInput(input: unknown): Omit<BotConfig, "id"> {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("A bot must be an object.");
  }
  const value = input as Record<string, unknown>;
  const name = text(value.name, "name", 64);
  const url = text(value.url, "url", 2_048);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`A bot's url must be absolute, received "${url}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("A bot's url must use http: or https:.");
  }

  const bot: {
    color?: string;
    description?: string;
    group?: string;
    name: string;
    pinned?: boolean;
    title?: string;
    token?: string;
    url: string;
  } = { name, url: parsed.toString().replace(/\/+$/, "") };

  if (value.title !== undefined) bot.title = text(value.title, "title", 96);
  if (value.description !== undefined)
    bot.description = text(value.description, "description", 512);
  if (value.group !== undefined) bot.group = text(value.group, "group", 48);
  if (value.token !== undefined) bot.token = text(value.token, "token", 4_096);
  if (value.pinned !== undefined) bot.pinned = value.pinned === true;
  if (value.color !== undefined) {
    const color = text(value.color, "color", 7);
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new TypeError("A bot's color must be a hex color.");
    bot.color = color;
  }
  return bot;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new TypeError(`A bot's ${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`A bot's ${field} cannot be empty.`);
  if (trimmed.length > max) {
    throw new TypeError(`A bot's ${field} is limited to ${max} characters.`);
  }
  return trimmed;
}
