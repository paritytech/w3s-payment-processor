/**
 * Close-out preflight. Regression for "I hit close out and no report appeared":
 * actions used to silently no-op (with a success toast) whenever a monitor
 * wasn't ready. Close-out is rail-neutral — it records amounts from BOTH
 * RFC-6 chain credits and coin payments — so the blocker only cares about
 * the enabled monitors being hydrated, never about which rail is enabled.
 */
import { describe, expect, it } from "vitest";

import { closeOutBlocker } from "@/features/dashboard/api/use-payment-stream.ts";

const READY = {
  v1Enabled: true,
  v2Enabled: true,
  engineReady: true,
  finalizedBlock: 1234,
  fiscalHydrated: true,
  v2Status: "running",
} as const;

describe("closeOutBlocker", () => {
  it("allows close-out when every enabled monitor is live", () => {
    expect(closeOutBlocker({ ...READY })).toBeNull();
  });

  it("allows close-out in a coin-only (v2) setup — Z reports cover both rails", () => {
    expect(
      closeOutBlocker({ ...READY, v1Enabled: false, engineReady: false, finalizedBlock: 0 }),
    ).toBeNull();
  });

  it("allows close-out in an RFC-6-only (v1) setup without waiting on v2", () => {
    expect(closeOutBlocker({ ...READY, v2Enabled: false, v2Status: "idle" })).toBeNull();
  });

  it("blocks until the fiscal store hydrated — a premature commit would reuse seq 1", () => {
    expect(closeOutBlocker({ ...READY, fiscalHydrated: false })).toMatch(/still loading/);
  });

  it("blocks while the v1 engine handle is still booting instead of faking success", () => {
    expect(closeOutBlocker({ ...READY, engineReady: false })).toMatch(/still starting/);
  });

  it("blocks before any block was scanned this session (v1 enabled)", () => {
    expect(closeOutBlocker({ ...READY, finalizedBlock: 0 })).toMatch(/No blocks scanned/);
  });

  it("blocks while the coin-payment monitor is booting (records not yet hydrated)", () => {
    expect(closeOutBlocker({ ...READY, v2Status: "resolving" })).toMatch(/coin-payment monitor/);
  });

  it("ignores the chain-watch state entirely when v1 is disabled", () => {
    expect(
      closeOutBlocker({ ...READY, v1Enabled: false, engineReady: false, finalizedBlock: 0 }),
    ).toBeNull();
  });
});
