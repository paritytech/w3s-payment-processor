import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnvFile, readEnvKey, upsertEnvFile } from "../scripts/lib/env-files.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "envfiles-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("upsertEnvFile", () => {
  it("creates a file with the header comment then the keys", () => {
    const path = join(dir, ".env");
    upsertEnvFile(path, { A: "1", B: "2" }, { headerComment: "# header" });
    const content = readFileSync(path, "utf8");
    expect(content.startsWith("# header\n")).toBe(true);
    expect(content).toContain("A=1\n");
    expect(content).toContain("B=2\n");
  });

  it("replaces an existing key in place, preserving comments and unrelated keys", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "# keep\nA=old\nB=keep\n");
    upsertEnvFile(path, { A: "new" });
    const content = readFileSync(path, "utf8");
    expect(content).toContain("# keep\n");
    expect(content).toContain("B=keep\n");
    expect(content).toContain("A=new\n");
    expect(content).not.toContain("A=old");
  });

  it("appends to a file lacking a trailing newline without gluing lines", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "A=1");
    upsertEnvFile(path, { B: "2" });
    const content = readFileSync(path, "utf8");
    expect(content).toContain("A=1\n");
    expect(content).toContain("B=2\n");
  });

  it("does not write the header comment when the file already exists", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "A=1\n");
    upsertEnvFile(path, { A: "2" }, { headerComment: "# should not appear" });
    const content = readFileSync(path, "utf8");
    expect(content).not.toContain("# should not appear");
    expect(content).toContain("A=2");
  });
});

describe("readEnvKey", () => {
  it("returns the last occurrence of a key", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "A=first\nA=last\n");
    expect(readEnvKey(path, "A")).toBe("last");
  });

  it("strips one layer of surrounding quotes", () => {
    const path = join(dir, ".env");
    writeFileSync(path, `A="quoted"\nB='single'\nC=plain\n`);
    expect(readEnvKey(path, "A")).toBe("quoted");
    expect(readEnvKey(path, "B")).toBe("single");
    expect(readEnvKey(path, "C")).toBe("plain");
  });

  it("returns undefined for a missing key, an empty value, and a missing file", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "A=1\nB=\n");
    expect(readEnvKey(path, "Z")).toBeUndefined();
    expect(readEnvKey(path, "B")).toBeUndefined();
    expect(readEnvKey(join(dir, "missing.env"), "A")).toBeUndefined();
  });

  it("lets a later empty value override an earlier non-empty one (tail -n 1)", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "A=first\nA=\n");
    expect(readEnvKey(path, "A")).toBeUndefined();
  });
});

describe("loadEnvFile", () => {
  const touched = ["LF_SET", "LF_PRESET", "LF_KV"];

  afterEach(() => {
    for (const k of touched) delete process.env[k];
  });

  it("sets unset keys but never overwrites a pre-set process.env key", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "LF_SET=from-file\nLF_PRESET=from-file\n");
    process.env.LF_PRESET = "from-shell";
    loadEnvFile(path);
    expect(process.env.LF_SET).toBe("from-file");
    expect(process.env.LF_PRESET).toBe("from-shell");
  });

  it("ignores comments and malformed lines", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "# comment\n\n=novalue\nnovalue\nLF_KV=ok\n");
    loadEnvFile(path);
    expect(process.env.LF_KV).toBe("ok");
  });

  it("is a no-op for a missing file", () => {
    expect(() => loadEnvFile(join(dir, "missing.env"))).not.toThrow();
  });
});
