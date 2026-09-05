import { useState } from "react";

import { api, type Bot } from "../lib/api.js";

/**
 * Adding a bot is two fields: what to call it and where it lives. Everything
 * else is editable afterwards in the inspector, so the first step never asks
 * for something a person does not have yet.
 */
export function AddBot({
  onCancel,
  onCreated,
}: {
  readonly onCancel: () => void;
  readonly onCreated: (bot: Bot) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const payload: Parameters<typeof api.createBot>[0] = { name: name.trim(), url: url.trim() };
      if (token.trim().length > 0) payload.token = token.trim();
      onCreated((await api.createBot(payload)).bot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add this bot.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="thread">
      <header className="thread__header">
        <div className="thread__heading">
          <div className="thread__name">New bot</div>
          <div className="thread__subtitle">Point the desktop at a running eve agent.</div>
        </div>
        <button className="button button--sm" onClick={onCancel} type="button">
          Cancel
        </button>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        style={{ maxWidth: 520, padding: 24 }}
      >
        <label className="field">
          <span className="field__label">Name</span>
          <input
            autoFocus
            onChange={(event) => setName(event.target.value)}
            placeholder="Release manager"
            value={name}
          />
        </label>

        <label className="field">
          <span className="field__label">Agent URL</span>
          <input
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://my-agent.vercel.app"
            value={url}
          />
        </label>

        <label className="field">
          <span className="field__label">Access token (optional)</span>
          <input
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
            placeholder="Sent as a bearer token to the agent"
            type="password"
            value={token}
          />
        </label>

        {error !== null ? (
          <p className="screen__error" role="alert">
            {error}
          </p>
        ) : null}

        <button
          className="button button--primary"
          disabled={saving || name.trim().length === 0 || url.trim().length === 0}
          type="submit"
        >
          {saving ? "Adding…" : "Add bot"}
        </button>
      </form>
    </section>
  );
}
