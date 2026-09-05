import { useEffect, useState } from "react";

import { api, type Bot } from "../lib/api.js";
import { Avatar } from "./Avatar.js";

export type InspectorTab = "details" | "pair";

interface InspectorProps {
  readonly bot: Bot;
  readonly onChange: (bot: Bot) => void;
  readonly onClose: () => void;
  readonly onDelete: (id: string) => void;
  readonly onTabChange: (tab: InspectorTab) => void;
  readonly tab: InspectorTab;
}

/**
 * The panel on the right: who this bot is, the machine it can drive, and how
 * to reach the same conversation from another device.
 */
export function Inspector({ bot, onChange, onClose, onDelete, onTabChange, tab }: InspectorProps) {
  return (
    <aside aria-label="Bot details" className="inspector">
      <div className="inspector__tabs" role="tablist">
        {(["details", "pair"] as const).map((value) => (
          <button
            aria-selected={tab === value}
            className="inspector__tab"
            key={value}
            onClick={() => onTabChange(value)}
            role="tab"
            type="button"
          >
            {value === "details" ? "Details" : "Pair"}
          </button>
        ))}
        <button
          className="button button--ghost button--sm"
          onClick={onClose}
          style={{ marginLeft: "auto" }}
          type="button"
        >
          Close
        </button>
      </div>

      <div className="inspector__body">
        {tab === "details" ? <Details bot={bot} onChange={onChange} onDelete={onDelete} /> : null}
        {tab === "pair" ? <Pair /> : null}
      </div>
    </aside>
  );
}

function Details({
  bot,
  onChange,
  onDelete,
}: {
  readonly bot: Bot;
  readonly onChange: (bot: Bot) => void;
  readonly onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState(bot);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setDraft(bot);
    setToken("");
    setStatus(null);
  }, [bot]);

  async function save(): Promise<void> {
    try {
      const payload: Parameters<typeof api.updateBot>[1] = {
        color: draft.color,
        description: draft.description,
        group: draft.group,
        name: draft.name,
        pinned: draft.pinned,
        title: draft.title,
        url: draft.url,
      };
      // An empty token field leaves the stored credential alone; clearing one
      // is a delete-and-recreate, not an accidental blank save.
      if (token.trim().length > 0) payload.token = token.trim();
      const result = await api.updateBot(bot.id, payload);
      onChange(result.bot);
      setToken("");
      setStatus("Saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save.");
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="inspector__identity">
        <Avatar color={draft.color} name={draft.name} size="lg" />
        <div>
          <div className="thread__name">{draft.name}</div>
          <div className="muted">{draft.title ?? "No title"}</div>
        </div>
      </div>

      <label className="field">
        <span className="field__label">Name</span>
        <input
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          value={draft.name}
        />
      </label>

      <label className="field">
        <span className="field__label">Title</span>
        <input
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          placeholder="Release manager"
          value={draft.title ?? ""}
        />
      </label>

      <label className="field">
        <span className="field__label">Description</span>
        <textarea
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          placeholder="What this bot is for."
          value={draft.description ?? ""}
        />
      </label>

      <label className="field">
        <span className="field__label">Agent URL</span>
        <input
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          value={draft.url}
        />
      </label>

      <label className="field">
        <span className="field__label">
          Access token {draft.hasToken ? "(stored — leave blank to keep)" : "(optional)"}
        </span>
        <input
          autoComplete="off"
          onChange={(event) => setToken(event.target.value)}
          placeholder={draft.hasToken ? "••••••••" : "Bearer token for this agent"}
          type="password"
          value={token}
        />
      </label>

      <label className="field">
        <span className="field__label">Group</span>
        <input
          onChange={(event) => setDraft({ ...draft, group: event.target.value })}
          placeholder="Work"
          value={draft.group ?? ""}
        />
      </label>

      <label className="row" style={{ marginBottom: 16 }}>
        <input
          checked={draft.pinned === true}
          onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })}
          type="checkbox"
        />
        <span>Pin to the top of the sidebar</span>
      </label>

      <div className="row">
        <button className="button button--primary" type="submit">
          Save
        </button>
        <button className="button button--danger" onClick={() => onDelete(bot.id)} type="button">
          Remove
        </button>
      </div>

      {status !== null ? (
        <p className="muted" style={{ marginTop: 12 }}>
          {status}
        </p>
      ) : null}
    </form>
  );
}

function Pair() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .pairing()
      .then(({ token }) => {
        setUrl(`${globalThis.location.origin}/?t=${encodeURIComponent(token)}`);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not read the pairing link.");
      });
  }, []);

  return (
    <div className="stack">
      <p className="muted">
        Open this link on your phone to continue the same conversations, and to watch or take over
        this computer.
      </p>
      {error !== null ? <p className="screen__error">{error}</p> : null}
      {url !== null ? (
        <>
          <p className="mono notice">{url}</p>
          <button
            className="button"
            onClick={() => void globalThis.navigator.clipboard?.writeText(url)}
            type="button"
          >
            Copy link
          </button>
        </>
      ) : null}
      <div className="divider" />
      <p className="notice notice--warning">
        The link is the credential. Anyone who opens it can read these conversations and control
        this machine. The desktop listens on localhost only until you start it with
        <span className="mono"> --host 0.0.0.0</span>.
      </p>
    </div>
  );
}
