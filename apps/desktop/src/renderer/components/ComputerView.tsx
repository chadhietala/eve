import { useCallback, useEffect, useRef, useState } from "react";

import { api, type Screenshot } from "../lib/api.js";

const REFRESH_MS = 1_200;

const KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backspace: "BackSpace",
  Delete: "Delete",
  End: "End",
  Enter: "Return",
  Escape: "Escape",
  Home: "Home",
  PageDown: "Page_Down",
  PageUp: "Page_Up",
  Tab: "Tab",
};

/**
 * A live view of the machine this app is hosting, and a way to drive it.
 *
 * The same view is what an agent sees through the computer tool, and the same
 * routes back it, so "watch what the agent is doing" and "take over" are the
 * same surface rather than two implementations. It works on a phone because
 * it is only an image plus pointer and key events.
 */
export function ComputerPane({
  backend,
  onClose,
}: {
  readonly backend: string;
  readonly onClose: () => void;
}) {
  return (
    <section aria-label="Computer" className="thread">
      <header className="thread__header">
        <button
          className="button button--ghost button--sm thread__back"
          onClick={onClose}
          type="button"
        >
          ‹
        </button>
        <div className="thread__heading">
          <div className="thread__name">This computer</div>
          <div className="thread__subtitle">
            {backend} · what an agent sees through the computer tool
          </div>
        </div>
        <button className="button button--sm" onClick={onClose} type="button">
          Back to chat
        </button>
      </header>
      <div className="screen__pane">
        <ComputerView />
      </div>
    </section>
  );
}

export function ComputerView() {
  const [screenshot, setScreenshot] = useState<Screenshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const [live, setLive] = useState(true);
  const imageRef = useRef<HTMLImageElement>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.screenshot();
      if (result.screenshot !== undefined) setScreenshot(result.screenshot);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The computer did not respond.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!live) return;
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);

  const act = useCallback(
    async (action: Record<string, unknown>) => {
      try {
        const result = await api.computerAction(action);
        if (result.screenshot !== undefined) setScreenshot(result.screenshot);
        else await refresh();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The action failed.");
      }
    },
    [refresh],
  );

  function pointFromEvent(event: { clientX: number; clientY: number }): [number, number] | null {
    const image = imageRef.current;
    if (image === null || screenshot === null) return null;
    const bounds = image.getBoundingClientRect();
    // The image is scaled to the panel, so pointer coordinates are mapped back
    // into the screen's own pixel space before they are sent.
    const x = Math.round(((event.clientX - bounds.left) / bounds.width) * screenshot.width);
    const y = Math.round(((event.clientY - bounds.top) / bounds.height) * screenshot.height);
    if (x < 0 || y < 0 || x >= screenshot.width || y >= screenshot.height) return null;
    return [x, y];
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button
          aria-pressed={control}
          className={control ? "button button--primary button--sm" : "button button--sm"}
          onClick={() => setControl((value) => !value)}
          type="button"
        >
          {control ? "Controlling" : "Take control"}
        </button>
        <button
          className="button button--sm"
          onClick={() => setLive((value) => !value)}
          type="button"
        >
          {live ? "Pause" : "Resume"}
        </button>
        <button className="button button--sm" onClick={() => void refresh()} type="button">
          Refresh
        </button>
      </div>

      {error !== null ? (
        <p className="screen__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="screen__frame">
        {screenshot === null ? (
          <p className="notice">Waiting for the first frame…</p>
        ) : (
          <img
            alt="The screen of the computer this app is hosting"
            className="screen"
            data-control={control ? "on" : "off"}
            onKeyDown={(event) => {
              if (!control) return;
              event.preventDefault();
              const named = KEY_NAMES[event.key];
              if (named !== undefined) {
                void act({ action: "key", keys: chord(event, named) });
                return;
              }
              if (event.key.length === 1) {
                void act(
                  event.ctrlKey || event.metaKey || event.altKey
                    ? { action: "key", keys: chord(event, event.key) }
                    : { action: "type", text: event.key },
                );
              }
            }}
            onPointerDown={(event) => {
              if (!control) return;
              const point = pointFromEvent(event);
              if (point === null) return;
              void act({
                action: event.detail >= 2 ? "double_click" : "left_click",
                coordinate: point,
              });
            }}
            onWheel={(event) => {
              if (!control) return;
              void act({
                action: "scroll",
                amount: Math.min(10, Math.max(1, Math.round(Math.abs(event.deltaY) / 100))),
                direction: event.deltaY > 0 ? "down" : "up",
              });
            }}
            ref={imageRef}
            src={`data:${screenshot.mediaType};base64,${screenshot.base64}`}
            tabIndex={control ? 0 : -1}
          />
        )}
      </div>

      <p className="screen__hint">
        {control
          ? "Click to click, type to type. Focus the screen first so keys reach it."
          : "Watching. Take control to click and type on this machine."}
        {screenshot === null ? "" : ` ${screenshot.width}×${screenshot.height}`}
      </p>

      <div className="keycaps">
        {["Return", "Escape", "Tab", "ctrl+c", "ctrl+v"].map((keys) => (
          <button
            className="button button--sm"
            disabled={!control}
            key={keys}
            onClick={() => void act({ action: "key", keys })}
            type="button"
          >
            {keys}
          </button>
        ))}
      </div>
    </div>
  );
}

function chord(
  event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  key: string,
): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey && key.length > 1) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}
