// Bootstrap publication atomicity: a failed first-time write must never leave
// a partial AGENTS.md behind, and an existing complete winner is never clobbered.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  ensureAgentWorkspace,
  seedWorkspaceBootstrap,
} from "./workspace.js";

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

function injectPartialPublicationFailure(dir: string, fileName: string) {
  const realOpen = fs.open.bind(fs);
  let injected = true;
  return vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
    const handle = await realOpen(filePath, flags, mode);
    const target = typeof filePath === "string" ? filePath : filePath.toString();
    const resolvedDir = path.resolve(dir);
    const isPublicationTarget =
      path.resolve(path.dirname(target)) === resolvedDir &&
      (path.basename(target) === fileName || path.basename(target).endsWith(".tmp"));
    if (injected && isPublicationTarget) {
      injected = false;
      const realHandleWrite = handle.writeFile.bind(handle);
      handle.writeFile = (async (data: unknown, encoding?: BufferEncoding) => {
        await realHandleWrite("# PARTIAL\n", typeof encoding === "string" ? encoding : "utf8");
        const err = new Error("ENOSPC") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }) as typeof handle.writeFile;
    }
    return handle;
  });
}

async function listTempSiblings(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.endsWith(".tmp")).toSorted();
}

describe("bootstrap publication atomicity", () => {
  it("does not publish a partial AGENTS.md when the first write fails", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const spy = injectPartialPublicationFailure(tempDir, DEFAULT_AGENTS_FILENAME);

    try {
      await expect(
        ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
      ).rejects.toThrow();
      await expectPathMissing(agentsPath);
      expect(await listTempSiblings(tempDir)).toEqual([]);
    } finally {
      spy.mockRestore();
    }

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const content = await fs.readFile(agentsPath, "utf-8");
    expect(content).not.toBe("# PARTIAL\n");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("leaves an existing complete AGENTS.md winner unchanged", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(agentsPath, "WINNER\n", "utf-8");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    expect(await fs.readFile(agentsPath, "utf-8")).toBe("WINNER\n");
  });

  it("preserves the raw bootstrap bytes including a UTF-8 BOM", async () => {
    // The Claw bootstrap flow approves raw bytes and later re-verifies them by
    // byte equality. Writing the decoded text (TextDecoder strips a leading
    // BOM) would persist different bytes and trip the existing-winner check.
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = Buffer.concat([bom, Buffer.from("# BOOTSTRAP\n")]);

    await expect(seedWorkspaceBootstrap({ dir: tempDir, content })).resolves.toBe("seeded");

    const written = await fs.readFile(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    expect(written.equals(content)).toBe(true);
  });
});
