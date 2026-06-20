# agent-memory

> [!NOTE]
> This app is internal test infrastructure, not a template or example.
> For a representative example agent, see
> [`apps/fixtures/weather-agent`](../../../apps/fixtures/weather-agent).

Fixture app for deterministic `eve eval` coverage of the working-memory layer.
It authors a `memory.md`, which mounts a durable memory store at `/memory`; the
framework file tools (`read_file`/`write_file`/`grep`/`glob`) redirect paths
under `/memory` to that store, and memory is keyed by the thread so it persists
across turns within one conversation. The eval proves cross-turn recall: one
turn persists an unusual fact to `/memory` and a later turn in the same thread
recalls it from memory rather than guessing.

## Run locally

```sh
pnpm exec eve eval --strict
```
