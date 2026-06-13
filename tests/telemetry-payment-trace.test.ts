import { beforeEach, describe, expect, it, vi } from "vitest";

const mockContinueTrace = vi.fn();

vi.mock("@sentry/react", () => ({
  continueTrace: (opts: { sentryTrace: string; baggage: unknown }, fn: () => unknown) => mockContinueTrace(opts, fn),
}));

import { withPaymentTrace } from "@/shared/utils/telemetry/payment-trace";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("withPaymentTrace", () => {
  it("calls continueTrace with sentryTrace starting with the 32-hex payment id", () => {
    const id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    mockContinueTrace.mockImplementation((_opts: unknown, fn: () => unknown) => fn());
    const result = withPaymentTrace(id, () => "done");
    expect(result).toBe("done");
    expect(mockContinueTrace).toHaveBeenCalledOnce();
    const { sentryTrace } = mockContinueTrace.mock.calls[0][0] as { sentryTrace: string };
    expect(sentryTrace.startsWith(id)).toBe(true);
  });

  it("runs fn directly (no continueTrace) when id is not 32 hex chars", () => {
    const fn = vi.fn(() => "direct");
    expect(withPaymentTrace("short-id", fn)).toBe("direct");
    expect(mockContinueTrace).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("runs fn directly when id has non-hex chars", () => {
    const fn = vi.fn(() => "direct2");
    expect(withPaymentTrace("gggggggggggggggggggggggggggggggg", fn)).toBe("direct2");
    expect(mockContinueTrace).not.toHaveBeenCalled();
  });
});
