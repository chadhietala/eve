# computer-agent

A fixture that wires eve's higher-level pieces together in one agent:

| File                            | Adds                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `agent/tools/computer.ts`       | [Computer use](../../../docs/computer.md): a screen, mouse, keyboard |
| `agent/memory/experience.ts`    | [Learning memory](../../../docs/learning-memory.md)                  |
| `agent/memory/improve.ts`       | [Self-improvement](../../../docs/self-improvement.md): proposals     |
| `agent/instructions/learned.ts` | The approved directives, as instructions                             |

Point it at the machine running the [desktop app](../../desktop/README.md):

```sh
EVE_COMPUTER_URL=http://127.0.0.1:7373 \
EVE_COMPUTER_TOKEN=<the desktop's pairing token> \
pnpm --filter computer-agent dev
```

Then add the agent in the desktop app, watch it work in the Computer pane, and
take the keyboard whenever it asks.
