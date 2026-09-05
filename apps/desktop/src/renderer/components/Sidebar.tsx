import { useMemo, useState } from "react";

import type { Bot } from "../lib/api.js";
import { Avatar } from "./Avatar.js";

interface SidebarProps {
  readonly backend: string;
  readonly bots: readonly Bot[];
  readonly onAdd: () => void;
  readonly onSelect: (id: string) => void;
  readonly selectedId: string | null;
}

/**
 * The contact list. Bots are grouped the way a messaging app groups
 * conversations — pinned first, then named groups, then everything else —
 * because that is the mental model people already have for "who am I talking
 * to".
 */
export function Sidebar({ backend, bots, onAdd, onSelect, selectedId }: SidebarProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => groupBots(bots, query), [bots, query]);

  return (
    <nav aria-label="Agents" className="sidebar">
      <header className="sidebar__header">
        <span className="sidebar__wordmark">eve</span>
        <button className="button button--sm" onClick={onAdd} type="button">
          New bot
        </button>
      </header>

      <div className="sidebar__search">
        <input
          aria-label="Search agents"
          className="input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          type="search"
          value={query}
        />
      </div>

      <div className="sidebar__list">
        {bots.length === 0 ? (
          <p className="sidebar__empty">
            No agents yet. Add one with its URL to start a conversation.
          </p>
        ) : null}

        {groups.map(([label, entries]) => (
          <section key={label}>
            <h2 className="sidebar__group">{label}</h2>
            {entries.map((bot) => (
              <button
                aria-selected={bot.id === selectedId}
                className="bot"
                key={bot.id}
                onClick={() => onSelect(bot.id)}
                role="tab"
                type="button"
              >
                <Avatar color={bot.color} name={bot.name} />
                <span className="bot__fields">
                  <span className="bot__name">{bot.name}</span>
                  <span className="bot__title">
                    {bot.title ?? bot.url.replace(/^https?:\/\//, "")}
                  </span>
                </span>
                {bot.pinned === true ? <span aria-label="Pinned">📌</span> : null}
              </button>
            ))}
          </section>
        ))}
      </div>

      <footer className="sidebar__footer">
        <span className="pill">
          <span className="dot" data-state="ok" />
          Computer: {backend}
        </span>
      </footer>
    </nav>
  );
}

function groupBots(bots: readonly Bot[], query: string): readonly [string, readonly Bot[]][] {
  const needle = query.trim().toLowerCase();
  const matching =
    needle.length === 0
      ? bots
      : bots.filter((bot) =>
          `${bot.name} ${bot.title ?? ""} ${bot.group ?? ""}`.toLowerCase().includes(needle),
        );

  const pinned = matching.filter((bot) => bot.pinned === true);
  const rest = matching.filter((bot) => bot.pinned !== true);
  const named = new Map<string, Bot[]>();
  for (const bot of rest) {
    const label = bot.group ?? "Agents";
    named.set(label, [...(named.get(label) ?? []), bot]);
  }

  const groups: [string, readonly Bot[]][] = [];
  if (pinned.length > 0) groups.push(["Pinned", pinned]);
  for (const [label, entries] of [...named].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    groups.push([label, entries.toSorted((left, right) => left.name.localeCompare(right.name))]);
  }
  return groups;
}
