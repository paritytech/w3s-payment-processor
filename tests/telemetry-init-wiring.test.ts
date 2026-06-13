import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSentryInit = vi.fn();
const mockSetTag = vi.fn();

vi.mock("@sentry/react", () => ({
  init: (...a: unknown[]) => mockSentryInit(...a),
  setTag: (...a: unknown[]) => mockSetTag(...a),
}));

import { scrubEvent } from "@/shared/utils/telemetry/scrub";
import { scrubTransaction } from "@/shared/utils/telemetry/scrub";
import { initTelemetry } from "@/shared/utils/telemetry/init";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("initTelemetry", () => {
  it("passes beforeSend=scrubEvent and beforeSendTransaction=scrubTransaction to Sentry.init", () => {
    initTelemetry({ dsn: "https://test@sentry.io/123", environment: "test" });
    expect(mockSentryInit).toHaveBeenCalledOnce();
    const opts = mockSentryInit.mock.calls[0]![0];
    expect(opts.beforeSend).toBe(scrubEvent);
    expect(opts.beforeSendTransaction).toBe(scrubTransaction);
  });

  it("sets e2e tag when window.__W3SPAY_E2E_TAG is present", () => {
    vi.stubGlobal("window", { __W3SPAY_E2E_TAG: "e2e-w3spay" });
    initTelemetry({ dsn: "https://test@sentry.io/123", environment: "test" });
    expect(mockSetTag).toHaveBeenCalledWith("tag", "e2e-w3spay");
    vi.unstubAllGlobals();
  });

  it("does not set tag when window.__W3SPAY_E2E_TAG is absent", () => {
    vi.stubGlobal("window", {});
    initTelemetry({ dsn: "https://test@sentry.io/123", environment: "test" });
    expect(mockSetTag).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
