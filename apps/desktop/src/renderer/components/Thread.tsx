import { useEffect, useRef, useState } from "react";
import { useEveAgent } from "eve/react";
import type { EveDynamicToolPart, EveMessage, EveMessagePart } from "eve/react";

import type { Bot } from "../lib/api.js";
import { Avatar } from "./Avatar.js";

interface ThreadProps {
  readonly bot: Bot;
  readonly computerOpen: boolean;
  readonly onBack: () => void;
  readonly onToggleComputer: () => void;
  readonly onToggleInspector: () => void;
}

/**
 * One conversation with one bot.
 *
 * The whole transport is eve's own client: `useEveAgent` points at the
 * control server's per-bot proxy, so streaming, resumption, tool projection,
 * and human-in-the-loop all behave exactly as they do in any other eve
 * frontend, and the same session continues on a phone.
 */
export function Thread({
  bot,
  computerOpen,
  onBack,
  onToggleComputer,
  onToggleInspector,
}: ThreadProps) {
  // Remounted per bot by `key`, so the hook's host binding is always current.
  const agent = useEveAgent({ host: `/api/bots/${bot.id}` });
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [agent.data.messages, agent.status]);

  const busy = agent.status === "streaming" || agent.status === "submitted";

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (text.length === 0 || busy) return;
    setDraft("");
    await agent.send(text);
  }

  return (
    <section aria-label={`Conversation with ${bot.name}`} className="thread">
      <header className="thread__header">
        <button
          className="button button--ghost button--sm thread__back"
          onClick={onBack}
          type="button"
        >
          ‹
        </button>
        <Avatar color={bot.color} name={bot.name} />
        <div className="thread__heading">
          <div className="thread__name">{bot.name}</div>
          <div className="thread__subtitle">
            {bot.title ?? bot.url.replace(/^https?:\/\//, "")}
            {busy ? " · working" : ""}
          </div>
        </div>
        <button
          aria-pressed={computerOpen}
          className="button button--sm"
          onClick={onToggleComputer}
          type="button"
        >
          Computer
        </button>
        <button className="button button--sm" onClick={onToggleInspector} type="button">
          Details
        </button>
      </header>

      <div className="thread__messages">
        {agent.data.messages.length === 0 ? (
          <div className="thread__empty">
            <div>
              <h2>Message {bot.name}</h2>
              <p className="muted">
                {bot.description ?? "This conversation continues on every device you pair."}
              </p>
            </div>
          </div>
        ) : null}

        {agent.data.messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            onRespond={(requestId, optionId) => void agent.respond([{ optionId, requestId }])}
          />
        ))}

        {agent.error !== undefined ? (
          <div className="screen__error" role="alert">
            {agent.error.message}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          aria-label={`Message ${bot.name}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={`Message ${bot.name}`}
          rows={1}
          value={draft}
        />
        {busy ? (
          <button className="button" onClick={() => void agent.cancel()} type="button">
            Stop
          </button>
        ) : (
          <button
            className="button button--primary"
            disabled={draft.trim().length === 0}
            type="submit"
          >
            Send
          </button>
        )}
      </form>
    </section>
  );
}

function Message({
  message,
  onRespond,
}: {
  readonly message: EveMessage;
  readonly onRespond: (requestId: string, optionId: string) => void;
}) {
  return (
    <div className="message" data-role={message.role}>
      {message.parts.map((part, index) => (
        <Part key={index} onRespond={onRespond} part={part} />
      ))}
      {message.metadata?.status === "failed" ? (
        <span className="message__meta">Not delivered</span>
      ) : null}
    </div>
  );
}

function Part({
  onRespond,
  part,
}: {
  readonly onRespond: (requestId: string, optionId: string) => void;
  readonly part: EveMessagePart;
}) {
  if (part.type === "text") return <div className="bubble">{part.text}</div>;

  if (part.type === "reasoning") {
    return (
      <details className="tool">
        <summary>Thinking</summary>
        <div className="muted">{part.text}</div>
      </details>
    );
  }

  if (part.type === "file") {
    return <span className="tool">{part.filename ?? part.mediaType}</span>;
  }

  if (part.type === "authorization") {
    return (
      <div className="approval">
        <div className="approval__title">{part.displayName} needs authorization</div>
        <div className="approval__body">{part.description}</div>
        {part.state === "required" && part.authorization?.url !== undefined ? (
          <a
            className="button button--primary"
            href={part.authorization.url}
            rel="noreferrer"
            target="_blank"
          >
            Continue
          </a>
        ) : null}
      </div>
    );
  }

  if (part.type === "dynamic-tool") return <ToolPart onRespond={onRespond} part={part} />;
  return null;
}

function ToolPart({
  onRespond,
  part,
}: {
  readonly onRespond: (requestId: string, optionId: string) => void;
  readonly part: EveDynamicToolPart;
}) {
  const request = part.toolMetadata?.eve?.inputRequest;

  if (part.state === "approval-requested" && request !== undefined) {
    return (
      <div className="approval">
        <div className="approval__title">{part.toolName} needs approval</div>
        <div className="approval__body">{request.prompt}</div>
        <div className="approval__actions">
          {(
            request.options ?? [
              { id: "approve", label: "Approve" },
              { id: "deny", label: "Deny" },
            ]
          ).map((option) => (
            <button
              className={option.style === "danger" ? "button button--danger" : "button"}
              key={option.id}
              onClick={() => onRespond(request.requestId, option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const state = part.state === "output-error" || part.state === "output-denied" ? "error" : "ok";
  return (
    <span className="tool" data-state={state}>
      <span className="dot" data-state={part.state === "output-available" ? "ok" : "busy"} />
      {part.toolName}
      {part.state === "output-error" ? ` · ${part.errorText}` : ""}
      {part.state === "output-denied" ? " · denied" : ""}
    </span>
  );
}
