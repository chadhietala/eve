const PALETTE = [
  "#0070f3",
  "#7928ca",
  "#f5a623",
  "#e5484d",
  "#0f9d58",
  "#00b8d9",
  "#d946ef",
  "#f97316",
] as const;

/** Two-letter monogram, the way a contact list shows one. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words.at(-1)![0]}`.toUpperCase();
}

/** Stable color for a bot with no explicit one, so avatars stay recognizable. */
export function avatarColor(seed: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}
