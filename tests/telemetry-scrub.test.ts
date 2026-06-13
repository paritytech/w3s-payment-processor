// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { afterEach, describe, expect, it } from "vitest";

import {
  _clearSecretsForTest,
  registerSecret,
  sanitizeExceptionMessage,
  scrubTransaction,
} from "@/shared/utils/telemetry/index.ts";

type TxEvent = Parameters<typeof scrubTransaction>[0];

function txEvent(partial: {
  spans?: Array<{ data: Record<string, unknown> }>;
  contexts?: { trace?: { data?: Record<string, unknown> } };
}): TxEvent {
  return partial as unknown as TxEvent;
}

afterEach(() => {
  _clearSecretsForTest();
});

describe("registerSecret + sanitizeExceptionMessage", () => {
  it("redacts a registered secret (>=8 chars) from an exception message", () => {
    registerSecret("S3CR3T-unlock-passkey-aaaaaaaa");
    const out = sanitizeExceptionMessage("threw S3CR3T-unlock-passkey-aaaaaaaa here");
    expect(out).not.toContain("S3CR3T");
    expect(out).toContain("«secret»");
  });

  it("ignores a <8-char secret so it can't corrupt unrelated text", () => {
    registerSecret("abc");
    expect(sanitizeExceptionMessage("abc def abcdef")).toBe("abc def abcdef");
  });

  it("is a byte-identical passthrough with an empty registry", () => {
    expect(sanitizeExceptionMessage("plain message, nothing secret")).toBe("plain message, nothing secret");
  });
});

describe("scrubTransaction", () => {
  it("drops SENSITIVE_KEY_RE span-data keys but keeps safe categorical ones", () => {
    const event = txEvent({ spans: [{ data: { "destination.address": "0xdeadbeef", "terminal.id": "955002-00" } }] });
    const out = scrubTransaction(event);
    expect(out).toBe(event);
    const data = (out.spans?.[0]?.data ?? {}) as Record<string, unknown>;
    expect(data["destination.address"]).toBeUndefined();
    expect(data["terminal.id"]).toBe("955002-00");
  });

  it("redacts registered secrets + 0x-hex from string span-data values", () => {
    registerSecret("S3CR3T-passkey-bbbbbbbb");
    const event = txEvent({ spans: [{ data: { note: `saw S3CR3T-passkey-bbbbbbbb and 0x${"a".repeat(40)}` } }] });
    const data = (scrubTransaction(event).spans?.[0]?.data ?? {}) as Record<string, unknown>;
    expect(String(data.note)).not.toContain("S3CR3T");
    expect(String(data.note)).toContain("«secret»");
    expect(String(data.note)).toContain("0x«hex»");
  });

  it("also scrubs contexts.trace.data", () => {
    const event = txEvent({ contexts: { trace: { data: { "merchant.id": "x", "topic.prefix": "deadbeef" } } } });
    const data = (scrubTransaction(event).contexts?.trace?.data ?? {}) as Record<string, unknown>;
    expect(data["merchant.id"]).toBeUndefined();
    expect(data["topic.prefix"]).toBe("deadbeef");
  });

  it("no-ops and returns the event when there are no spans or trace data", () => {
    const event = txEvent({});
    expect(scrubTransaction(event)).toBe(event);
  });
});
