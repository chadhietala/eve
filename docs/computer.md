---
title: "Computer Use"
description: "Give an agent a screen, a mouse, and a keyboard — on a virtual screen, the local display, or a machine across the network."
---

Computer use lets an agent do the work that has no API: sign in to an app,
click through an interface, read a screen that only a person was meant to
read. eve owns the action vocabulary the model speaks, the bounds on every
action, and the protocol between an agent and a machine. A _backend_ owns how
a screenshot is captured and how input reaches the operating system.

| eve owns                                          | The backend owns               |
| ------------------------------------------------- | ------------------------------ |
| The action vocabulary and its schema              | Screen capture                 |
| Bounds on text, duration, scroll, and coordinates | Input injection                |
| The wire protocol and its error reasons           | Platform tools and permissions |
| Approval policy and durable tool results          | What "the screen" means        |

## Add the tool

Computer use is opt-in. A tool that clicks on a real machine is not a safe
default, so an agent gets it by declaring it:

```ts title="agent/tools/computer.ts"
export { default } from "eve/tools/computer";
```

The filename supplies the model-facing name, so the model sees one `computer`
tool. It takes one action per call and returns a short summary plus, for any
action that changes the screen, a PNG the model sees as an image.

## Choose a backend

With no explicit backend, the tool resolves one from the environment on its
first action:

| Environment                                    | Backend                                 |
| ---------------------------------------------- | --------------------------------------- |
| `EVE_COMPUTER_URL` and `EVE_COMPUTER_TOKEN`    | The machine running a computer host     |
| A local display (`DISPLAY`, macOS, or Windows) | The display eve is running on           |
| Every other environment                        | An error asking for an explicit backend |

Pass one explicitly when the agent should always drive a specific machine:

```ts title="agent/tools/computer.ts"
import { computer } from "eve/tools/computer";
import { remoteComputer } from "eve/computer";

export default computer({
  backend: remoteComputer({
    token: process.env.DESKTOP_TOKEN!,
    url: process.env.DESKTOP_URL!,
  }),
});
```

`remoteComputer()` requires `https:`, or `http:` on a loopback address, so the
token never crosses a network in the clear.

### Drive the local display

`systemComputer()` controls the display of the machine eve is running on. It
delegates to the tools each platform ships with or conventionally installs:

| Platform    | Screen capture                          | Input      |
| ----------- | --------------------------------------- | ---------- |
| Linux (X11) | ImageMagick `import`, `scrot`, or GNOME | `xdotool`  |
| macOS       | `screencapture`                         | `cliclick` |
| Windows     | PowerShell with `System.Drawing`        | PowerShell |

A missing tool raises an error naming the tool and its install command, so the
agent reports something the operator can act on instead of a spawn failure.
macOS additionally needs Screen Recording and Accessibility permission for the
process running eve.

### Drive a virtual screen

`virtualComputer()` is a complete in-process computer: it renders a real PNG,
tracks a cursor, and routes clicks to elements you declare. Use it in tests
and evals, where a display server is not available and a deterministic screen
is worth more than a real one:

```ts
import { virtualComputer } from "eve/computer";

const screen = virtualComputer({
  title: "Inbox",
  elements: [
    {
      id: "compose",
      bounds: [24, 80, 160, 48],
      label: "COMPOSE",
      onActivate: () => opened.push("compose"),
    },
  ],
});
```

It records every action, the typed text, and the key chords, so an eval can
assert what the agent did, not only what it said.

## Host a machine

`createComputerHost()` exposes one backend over the computer protocol as an
ordinary `Request` handler. This is how a machine a person sits in front of
becomes drivable by an agent deployed somewhere else:

```ts
import { createComputerHost, systemComputer } from "eve/computer";

const handle = createComputerHost({
  backend: systemComputer(),
  token: process.env.COMPUTER_TOKEN!,
});
```

The token must be at least 16 characters and is compared in constant time.
There is no unauthenticated mode: the host is full control of a machine.

The eve desktop app mounts this host for the desktop it runs on, so an agent —
and a person on their phone — can drive the same screen.

## Actions

| Action                                      | Does                                             |
| ------------------------------------------- | ------------------------------------------------ |
| `screenshot`                                | Capture the screen as a PNG the model can see    |
| `screen_size`                               | Report the screen's pixel dimensions             |
| `cursor_position`                           | Report where the cursor is                       |
| `mouse_move`                                | Move the cursor                                  |
| `left_click`, `right_click`, `middle_click` | Click, optionally with held modifiers            |
| `double_click`, `triple_click`              | Repeat clicks                                    |
| `left_mouse_down`, `left_mouse_up`          | Hold and release for a custom gesture            |
| `left_click_drag`                           | Press, move, and release                         |
| `scroll`                                    | Scroll in a direction by a number of clicks      |
| `type`                                      | Enter literal text; does not press Enter         |
| `key`, `hold_key`                           | Press a chord in xdotool notation, e.g. `ctrl+s` |
| `wait`                                      | Wait for an application to catch up              |

Coordinates are pixels from the top-left of the screenshot the model just saw.
Every action is bounded before it reaches a backend: 4,096 characters per
`type`, 30 seconds per `wait` or `hold_key`, 25 clicks per `scroll`, and
coordinates within 0–32,767.

`isReadOnlyComputerAction()` identifies the four actions that cannot change
the machine (`screenshot`, `screen_size`, `cursor_position`, `wait`), so an
application can apply a narrower approval policy to them.

## Approvals

The tool's default policy is `once()`: the first action of a session asks for
approval, and the rest proceed. Change it like any other tool:

```ts title="agent/tools/computer.ts"
import { computer } from "eve/tools/computer";
import { always } from "eve/tools/approval";

export default computer({ approval: always() });
```

Approving computer use approves everything the signed-in machine can do. Give
an agent a machine scoped to the work, not a personal desktop with a password
manager open.

## Failure behavior

Every failure crosses the protocol with a reason:

| Reason         | Means                                            |
| -------------- | ------------------------------------------------ |
| `unavailable`  | No machine could be reached                      |
| `unsupported`  | A required tool or permission is missing         |
| `invalid`      | The action was rejected by validation or a bound |
| `unauthorized` | The host refused the token                       |
| `failed`       | The action started but did not complete          |

Messages name the concrete next step — the package to install, the permission
to grant, the environment variable to set — because a computer failure is
almost always something only the operator can fix.

## What to read next

- [Built-in tools](./concepts/built-in-tools): the rest of the framework tool
  set.
- [Human-in-the-loop](/docs/human-in-the-loop): how approvals pause and
  resume a turn.
