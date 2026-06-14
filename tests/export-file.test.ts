// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  env: "standalone" as "standalone" | "web-iframe" | "desktop-webview",
  saveFile: vi.fn<(opts: { fileName: string; content: string; mimeType?: string }) => Promise<void>>(),
}));

vi.mock("@/shared/api/host/connection.ts", () => ({
  detectHostEnvironment: () => hoisted.env,
}));
vi.mock("@/shared/utils/download.ts", () => ({
  saveFile: hoisted.saveFile,
}));

class FakeFile {
  constructor(
    readonly parts: readonly unknown[],
    readonly name: string,
    readonly opts: { type?: string },
  ) {}
}

import { exportFile } from "@/shared/utils/export-file.ts";
import { useExportFallbackStore } from "@/shared/store/use-export-fallback-store.ts";

const OPTS = { fileName: "report.csv", content: "a,b\n1,2", mimeType: "text/csv" } as const;

describe("exportFile", () => {
  beforeEach(() => {
    hoisted.env = "standalone";
    hoisted.saveFile.mockReset().mockResolvedValue(undefined);
    useExportFallbackStore.getState().close();
    vi.stubGlobal("File", FakeFile);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the native share sheet when it can share files (iOS host route)", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    hoisted.env = "web-iframe";
    vi.stubGlobal("navigator", { share, canShare: () => true });

    await exportFile(OPTS);

    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]![0]).toMatchObject({ title: "report.csv" });
    expect(hoisted.saveFile).not.toHaveBeenCalled();
    expect(useExportFallbackStore.getState().fileName).toBeNull();
  });

  it("treats a user-cancelled share (AbortError) as done — no fallback fires", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("dismissed", "AbortError"));
    hoisted.env = "web-iframe";
    vi.stubGlobal("navigator", { share, canShare: () => true });

    await exportFile(OPTS);

    expect(hoisted.saveFile).not.toHaveBeenCalled();
    expect(useExportFallbackStore.getState().fileName).toBeNull();
  });

  it("falls back to clipboard + manual-save panel in a sandboxed iframe (dot.li)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    hoisted.env = "web-iframe";
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await exportFile(OPTS);

    expect(writeText).toHaveBeenCalledWith(OPTS.content);
    expect(hoisted.saveFile).not.toHaveBeenCalled();
    const state = useExportFallbackStore.getState();
    expect(state.fileName).toBe("report.csv");
    expect(state.content).toBe(OPTS.content);
  });

  it("triggers a real file download on desktop / standalone browsers", async () => {
    hoisted.env = "standalone";
    vi.stubGlobal("navigator", {});

    await exportFile(OPTS);

    expect(hoisted.saveFile).toHaveBeenCalledWith(OPTS);
    expect(useExportFallbackStore.getState().fileName).toBeNull();
  });
});
