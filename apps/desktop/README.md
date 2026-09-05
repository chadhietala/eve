# eve desktop

A desktop client for eve agents. It is shaped like a messaging app: a sidebar
of agents you pin and group, a thread per agent, an inspector for who that
agent is, and a live view of the machine an agent can drive.

The window is a thin Electron shell around a local control server. The same
server serves the same app to a browser, so a phone on the pairing link sees
the same conversations and the same screen.

```
┌──────────┬──────────────────────────┬──────────────┐
│ agents   │ thread  /  this computer │ inspector    │
│ pinned   │                          │ details      │
│ groups   │                          │ pair a phone │
└──────────┴──────────────────────────┴──────────────┘
        └── control server ──► eve agents (proxied, with credentials)
                          └──► this machine (eve computer host)
```

## Run it

```sh
pnpm --filter @eve/desktop desktop     # the Electron window
pnpm --filter @eve/desktop serve       # the same app in a browser
pnpm --filter @eve/desktop dev         # Vite renderer + control server
```

The first launch of the Electron shell fetches its runtime (~150 MB); the
workspace install deliberately skips it.

`serve` prints a pairing link. The link is the credential:

```
eve desktop is serving on http://127.0.0.1:7373
Open this on another device to pair it:
  http://127.0.0.1:7373/?t=...
```

Use `--host 0.0.0.0` to reach it from a phone on the same network. The server
binds loopback otherwise, because it is full control of the machine.

## Add an agent

Every agent needs a name and the URL of a running eve agent. Requests are
proxied through the control server, which attaches the agent's bearer token
if you gave it one — the renderer never sees that token.

The thread is driven by eve's own client (`useEveAgent` from `eve/react`)
against a per-bot proxy, so streaming, resumption, tool calls, and approvals
behave exactly as they do in any other eve frontend.

## The computer

The desktop hosts a computer for the machine it runs on, using
[`eve/computer`](../../docs/computer.md). Two things use it:

- **You**, through the "Computer" pane: watch the screen, take control, click
  and type, from the desktop or from a paired phone.
- **An agent**, through the computer protocol at `/computer/v1/*`, so an agent
  running anywhere can see and drive this screen:

  ```sh
  EVE_COMPUTER_URL=https://<this machine>/ \
  EVE_COMPUTER_TOKEN=<the pairing token> \
  pnpm --filter my-agent dev
  ```

Set `EVE_DESKTOP_COMPUTER=virtual` to run against a simulated screen. That is
how the UI is exercised where there is no display, and how to try the app
before pointing it at a real machine.

## Configuration

`~/.eve/desktop/config.json` (override with `EVE_DESKTOP_CONFIG`) holds the
agents and the control token. It is written `0600` through a temporary file, so
a crash mid-write cannot truncate it and unpair every device.

## Layout

| Path                  | Is                                                     |
| --------------------- | ------------------------------------------------------ |
| `src/server/`         | The control server: config, API, agent proxy, computer |
| `src/renderer/`       | The React app, served to the window and to phones      |
| `src/main/`           | The Electron shell                                     |
| `test/server.test.ts` | Server behavior, including auth and the proxy          |
