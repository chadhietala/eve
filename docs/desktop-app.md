---
title: "Desktop App"
description: "A messaging-shaped desktop client for eve agents, with a live view of the machine an agent is driving and the same conversation on your phone."
---

The eve desktop app is a client for the agents you already run. It is shaped
like a messaging app, because that is what talking to a durable agent is: a
sidebar of agents you pin and group, one thread each, and an inspector for who
that agent is and what machine it can reach.

```
┌──────────┬──────────────────────────┬──────────────┐
│ agents   │ thread  /  this computer │ inspector    │
│ pinned   │                          │ details      │
│ groups   │                          │ pair a phone │
└──────────┴──────────────────────────┴──────────────┘
```

The window is a thin shell around a local control server. The same server
serves the same app over HTTP, so a phone on the pairing link continues the
same conversations and sees the same screen.

## Run it

```sh
pnpm --filter @eve/desktop desktop   # the window
pnpm --filter @eve/desktop serve     # the same app in a browser
```

`serve` prints a pairing link. Open it on another device to pair that device:

```
eve desktop is serving on http://127.0.0.1:7373
Open this on another device to pair it:
  http://127.0.0.1:7373/?t=...
```

The link is the credential. The server binds loopback until you pass
`--host 0.0.0.0`, because it is full control of the machine it runs on.

## Add an agent

An agent needs a name and its URL. Add an access token if the agent requires
one: the control server attaches it as a bearer token on the way out, and the
renderer never receives it.

Requests are proxied per agent, and the thread is driven by
[eve's own client](./guides/client/overview) — `useEveAgent` pointed at that proxy. So
streaming, resumption, tool calls, and [approvals](/docs/human-in-the-loop)
behave exactly as they do in any other eve frontend, and the same durable
session continues wherever you open it.

## Watch and take over the computer

The desktop hosts a [computer](./computer) for the machine it runs on. The
"Computer" pane shows that screen live and, when you take control, sends your
clicks and keystrokes to it — from the desktop or from a paired phone.

The same machine is what an agent drives through the computer tool. Point an
agent at it with the pairing token:

```sh
EVE_COMPUTER_URL=https://<this machine>/
EVE_COMPUTER_TOKEN=<the pairing token>
```

Watching the agent work and taking over from it are the same surface, so the
handoff needs no coordination: approve a step in the thread, take the keyboard
for a login the agent cannot do, and hand it back.

## Try it without a display

```sh
EVE_DESKTOP_COMPUTER=virtual pnpm --filter @eve/desktop serve
```

The app runs against a simulated screen with clickable elements. Use it to see
how the computer pane behaves before pointing it at a real machine, or to run
the app where there is no display at all.

## What to read next

- [Computer use](./computer): the tool and backends the computer pane is built on.
- [Client](./guides/client/overview): the client the thread uses.
- [Human-in-the-loop](/docs/human-in-the-loop): how an approval reaches you.
