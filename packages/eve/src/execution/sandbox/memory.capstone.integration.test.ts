import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { executeReadFileOnSandbox } from "#execution/sandbox/read-file-tool.js";
import { executeWriteFileOnSandbox } from "#execution/sandbox/write-file-tool.js";
import { FsMemoryStore } from "#runtime/memory/fs-store.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";

/**
 * End-to-end proof: a write through the real `write_file` tool to a path under a
 * mounted store is readable through the real `read_file` tool in a later turn —
 * modeled here as a fresh context with a brand-new backend instance pointing at
 * the same directory (i.e. it survives process/session boundaries).
 *
 * The sandbox throws on any access, so a passing test also proves the file tools
 * redirected to the memory store and never touched the sandbox.
 */

const ROOT = "/mnt/memory";

// A sandbox that fails loudly if any method is called — for a /mnt/memory path
// the tools must redirect to the store and leave the sandbox untouched.
const sandboxNeverTouched = new Proxy({} as Parameters<typeof executeReadFileOnSandbox>[0], {
  get(_target, prop) {
    if (typeof prop === "symbol") {
      return undefined;
    }
    return () => {
      throw new Error(`sandbox.${String(prop)} must not be called for a memory path`);
    };
  },
});

function configFor(backend: MountedStore["backend"]): MemoryConfig {
  return {
    root: ROOT,
    stores: [{ name: "notes", backend, mountPath: `${ROOT}/notes`, access: "rw" }],
  };
}

async function inTurn<T>(config: MemoryConfig, fn: () => Promise<T>): Promise<T> {
  const ctx = new ContextContainer();
  ctx.set(MemoryConfigKey, config);
  return contextStorage.run(ctx, fn) as Promise<T>;
}

describe("memory layer end-to-end (file tools → store)", () => {
  it("a named file written to a mounted store in one turn is readable in a later turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eve-mem-capstone-"));
    try {
      // Turn 1 — write a named file in place through the real write_file tool.
      await inTurn(configFor(new FsMemoryStore(dir)), async () => {
        const result = await executeWriteFileOnSandbox(sandboxNeverTouched, {
          content: "remembered across turns",
          filePath: "/mnt/memory/notes/index.md",
        });
        expect(result.existed).toBe(false);
      });

      // Turn 2 — brand-new context AND a new backend instance over the same dir,
      // standing in for a fresh session. Read it back via the read_file tool.
      const content = await inTurn(configFor(new FsMemoryStore(dir)), async () => {
        const result = await executeReadFileOnSandbox(sandboxNeverTouched, {
          filePath: "/mnt/memory/notes/index.md",
        });
        return result.content;
      });

      expect(content).toContain("remembered across turns");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
