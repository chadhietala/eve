import { describe, expect, it } from "vitest";

import { MemoryFuseFilesystem } from "#runtime/memory/fuse/filesystem.js";
import { FuseError, S_IFDIR, S_IFREG } from "#runtime/memory/fuse/types.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Writes `text` to `path` through the full create → write → release lifecycle. */
async function writeFile(fs: MemoryFuseFilesystem, path: string, text: string): Promise<void> {
  const fd = await fs.create(path, 0o644);
  const bytes = enc.encode(text);
  await fs.write(path, fd, bytes, bytes.length, 0);
  await fs.release(path, fd);
}

/** Reads the whole file at `path` back through open → read → release. */
async function readFile(fs: MemoryFuseFilesystem, path: string): Promise<string> {
  const fd = await fs.open(path, 0);
  const attr = await fs.getattr(path);
  const buf = new Uint8Array(attr.size);
  const n = await fs.read(path, fd, buf, buf.length, 0);
  await fs.release(path, fd);
  return dec.decode(buf.subarray(0, n));
}

describe("MemoryFuseFilesystem", () => {
  it("round-trips a create/write/release then read", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    await writeFile(fs, "/notes/facts.md", "Priya owns the deploy token.");
    expect(await readFile(fs, "/notes/facts.md")).toBe("Priya owns the deploy token.");
  });

  it("reports files and directories via getattr", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    await writeFile(fs, "/notes/a.md", "hi");

    const file = await fs.getattr("/notes/a.md");
    expect(file.mode & S_IFREG).toBe(S_IFREG);
    expect(file.size).toBe(2);

    const dir = await fs.getattr("/notes");
    expect(dir.mode & S_IFDIR).toBe(S_IFDIR);

    const root = await fs.getattr("/");
    expect(root.mode & S_IFDIR).toBe(S_IFDIR);
  });

  it("throws ENOENT for a missing path", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    await expect(fs.getattr("/missing.md")).rejects.toBeInstanceOf(FuseError);
    await expect(fs.getattr("/missing.md")).rejects.toMatchObject({ errno: 2 });
  });

  it("lists immediate children, not a sibling that merely shares a prefix", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    await writeFile(fs, "/notes/a.md", "a");
    await writeFile(fs, "/notes/sub/b.md", "b");
    await writeFile(fs, "/notesbook.md", "x"); // sibling sharing the "notes" prefix

    const listing = await fs.readdir("/notes");
    expect(listing.filter((n) => n !== "." && n !== "..").sort()).toEqual(["a.md", "sub"]);
    // The prefix-sharing sibling is NOT treated as a child of /notes.
    expect(listing).not.toContain("notesbook.md");
  });

  it("reflects unflushed writes in getattr before release", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    const fd = await fs.create("/pending.md", 0o644);
    const bytes = enc.encode("twelve bytes");
    await fs.write("/pending.md", fd, bytes, bytes.length, 0);

    // Visible with its buffered size even though nothing was flushed yet.
    expect((await fs.getattr("/pending.md")).size).toBe(12);
    await fs.release("/pending.md", fd);
    expect(await readFile(fs, "/pending.md")).toBe("twelve bytes");
  });

  it("supports session mkdir before the directory holds a file", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    await fs.mkdir("/scratch", 0o755);
    expect((await fs.getattr("/scratch")).mode & S_IFDIR).toBe(S_IFDIR);
    expect(await fs.readdir("/")).toContain("scratch");

    await writeFile(fs, "/scratch/x.md", "materialized");
    expect(await readFile(fs, "/scratch/x.md")).toBe("materialized");
  });

  it("truncates an open handle and persists the shortened content", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    await writeFile(fs, "/f.md", "hello world");
    const fd = await fs.open("/f.md", 0);
    await fs.ftruncate("/f.md", fd, 5);
    await fs.release("/f.md", fd);
    expect(await readFile(fs, "/f.md")).toBe("hello");
  });

  it("unlinks a file", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    await writeFile(fs, "/gone.md", "x");
    await fs.unlink("/gone.md");
    await expect(fs.getattr("/gone.md")).rejects.toMatchObject({ errno: 2 });
  });

  it("renames a file (copy + remove)", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    await writeFile(fs, "/old.md", "content");
    await fs.rename("/old.md", "/new.md");
    expect(await readFile(fs, "/new.md")).toBe("content");
    await expect(fs.getattr("/old.md")).rejects.toMatchObject({ errno: 2 });
  });

  it("keeps both writers' data across a shared store (last-writer head, loser in history)", async () => {
    // Two filesystems over the SAME backend model two sandboxes on one store.
    const store = new InMemoryMemoryStore();
    const a = new MemoryFuseFilesystem(store);
    const b = new MemoryFuseFilesystem(store);

    await writeFile(a, "/shared.md", "from A");
    await writeFile(b, "/shared.md", "from B"); // CAS: B reads A's head, writes under it

    // B won the head; A's revision survives in the version trail — no lost write.
    expect(await readFile(a, "/shared.md")).toBe("from B");
    const versions = await store.listVersions("shared.md");
    expect(versions.length).toBe(2);
  });

  it("reports a large, non-full filesystem via statfs", async () => {
    const fs = new MemoryFuseFilesystem(new InMemoryMemoryStore());
    const stat = await fs.statfs("/");
    expect(stat.bavail).toBeGreaterThan(0);
    expect(stat.namemax).toBe(255);
  });
});

describe("MemoryFuseFilesystem read-only mount", () => {
  const EROFS = 30;

  /** A ro filesystem over a store already seeded (through a rw view) with a file. */
  async function seededReadOnly(): Promise<MemoryFuseFilesystem> {
    const store = new InMemoryMemoryStore();
    await writeFile(new MemoryFuseFilesystem(store), "/notes/facts.md", "seeded");
    return new MemoryFuseFilesystem(store, { readOnly: true });
  }

  it("still serves reads, listings, and stats", async () => {
    const fs = await seededReadOnly();
    expect(await readFile(fs, "/notes/facts.md")).toBe("seeded");
    expect(await fs.readdir("/notes")).toContain("facts.md");
    expect((await fs.getattr("/notes/facts.md")).size).toBe(6);
  });

  it("rejects create, write-open, truncate, unlink, rename, mkdir, and rmdir with EROFS", async () => {
    const fs = await seededReadOnly();
    await expect(fs.create("/new.md", 0o644)).rejects.toMatchObject({ errno: EROFS });
    await expect(fs.open("/notes/facts.md", 0o1)).rejects.toMatchObject({ errno: EROFS }); // O_WRONLY
    await expect(fs.truncate("/notes/facts.md", 0)).rejects.toMatchObject({ errno: EROFS });
    await expect(fs.unlink("/notes/facts.md")).rejects.toMatchObject({ errno: EROFS });
    await expect(fs.rename("/notes/facts.md", "/notes/moved.md")).rejects.toMatchObject({
      errno: EROFS,
    });
    await expect(fs.mkdir("/dir", 0o755)).rejects.toMatchObject({ errno: EROFS });
    await expect(fs.rmdir("/notes")).rejects.toMatchObject({ errno: EROFS });
  });

  it("permits a read-intent open (O_RDONLY) but rejects any write through it", async () => {
    const fs = await seededReadOnly();
    const fd = await fs.open("/notes/facts.md", 0); // O_RDONLY — allowed
    await expect(fs.write("/notes/facts.md", fd, enc.encode("x"), 1, 0)).rejects.toMatchObject({
      errno: EROFS,
    });
  });

  it("never mutates the underlying store", async () => {
    const store = new InMemoryMemoryStore();
    await writeFile(new MemoryFuseFilesystem(store), "/notes/facts.md", "seeded");
    const fs = new MemoryFuseFilesystem(store, { readOnly: true });
    await expect(fs.create("/new.md", 0o644)).rejects.toBeInstanceOf(FuseError);
    expect(await store.read("new.md")).toBeNull();
    expect((await store.listVersions("notes/facts.md")).length).toBe(1);
  });
});
