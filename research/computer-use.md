---
issue: "chadhietala/eve branch claude/eve-agents-desktop-computer-use-r50l3o (repository issues are disabled; tracked on the branch)"
status: proposed
last_updated: "2026-09-05"
---

# Computer use

## Proposal

An eve agent can see a screen and drive a mouse and keyboard. eve owns the
action vocabulary, the bounds on every action, and the wire protocol between
an agent and a machine. A _backend_ owns how a screenshot is captured and how
input reaches the operating system.

That split is the whole design. Screen capture and input injection are
operating-system services with no portable API, so the framework cannot own
them — but the vocabulary a model speaks, the bounds that keep one tool call
from typing a megabyte, and the protocol that lets a serverless agent reach a
laptop all belong in the framework, because every backend needs them and
because they are what an agent's durable history records.

```
 agent (anywhere)                        machine (anywhere)
┌──────────────────┐   computer proto   ┌─────────────────────┐
│ computer tool    │ ─────────────────► │ createComputerHost  │
│  └ ComputerBackend                    │  └ ComputerBackend  │
└──────────────────┘                    └─────────────────────┘
   virtual | system | remote                system | virtual
```

## Authoring API

Computer use is opt-in per agent, because a tool that clicks on a real
machine is not a safe default. An author enables it with one file:

```ts title="agent/tools/computer.ts"
export { default } from "eve/tools/computer";
```

That binds the environment-resolved backend. To bind a specific machine,
call the factory instead:

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

The tool takes one discriminated action and returns a result whose
`toModelOutput` hands the model a text summary plus, for any action that
changes the screen, a PNG as a vision part.

### Actions

`screenshot`, `screen_size`, `cursor_position`, `mouse_move`, `left_click`,
`right_click`, `middle_click`, `double_click`, `triple_click`,
`left_mouse_down`, `left_mouse_up`, `left_click_drag`, `scroll`, `type`,
`key`, `hold_key`, `wait`.

The names follow the widely implemented computer-use vocabulary so a model
trained on it needs no translation layer. Coordinates are pixels from the
top-left of the screenshot the model just saw. Key chords use xdotool
notation (`ctrl+s`, `alt+Tab`) on every platform; non-X11 adapters translate.

### Backends

| Backend             | Drives                                            |
| ------------------- | ------------------------------------------------- |
| `virtualComputer()` | An in-process framebuffer with clickable elements |
| `systemComputer()`  | The display of the machine eve is running on      |
| `remoteComputer()`  | Any machine running a computer host               |

`virtualComputer()` renders a real PNG through an eve-owned encoder and routes
clicks to declared elements, so computer-use behavior is assertable in unit
tests and evals with no display server. `systemComputer()` delegates to the
tools that ship with (or are conventionally installed on) each platform —
`xdotool` and ImageMagick or scrot on X11, `screencapture` and `cliclick` on
macOS, PowerShell with `user32` on Windows — and a missing tool raises a
`ComputerError` naming the tool and its install command rather than a spawn
failure.

### Hosting a machine

`createComputerHost({ backend, token })` returns a `Request` handler that
exposes one backend over the protocol. The eve desktop app mounts it for the
desktop it runs on; any runtime with `fetch` types can mount it for a sandbox
or a kiosk.

## Externally observable semantics

- Every action is bounded before it reaches a backend: 4,096 characters per
  `type`, 30 seconds per `wait` or `hold_key`, 25 clicks per `scroll`,
  coordinates within 0–32,767, and a 64 KiB request body at a host.
- Read-only actions (`screenshot`, `screen_size`, `cursor_position`, `wait`)
  are identified by `isReadOnlyComputerAction()` so a caller can apply a
  narrower approval policy to them.
- The tool's default approval is `once()`. The first action in a session asks;
  the rest proceed.
- A host requires a token of at least 16 characters and compares it in
  constant time. There is no unauthenticated mode.
- `remoteComputer()` requires `https:`, or `http:` on a loopback address, so a
  token is never sent in the clear to a remote host.
- A backend failure crosses the protocol as a `reason` (`unavailable`,
  `unsupported`, `invalid`, `unauthorized`, `failed`) with the HTTP status
  that matches it, and the client rethrows a `ComputerError` carrying both.
- The default backend resolves lazily: `EVE_COMPUTER_URL` and
  `EVE_COMPUTER_TOKEN` select a remote machine; a local display selects the
  system backend; anything else raises an error naming both options.

## Boundaries

- eve does not manage a display server, a VNC session, or a recording. A
  backend that needs one owns it.
- The protocol is request/response. Live screen streaming is a desktop-app
  concern, not a framework one; it is built from repeated `screenshot`
  actions.
- Screenshots cross the durable JSON boundary as base64 PNG, like every other
  file part in a tool result.
