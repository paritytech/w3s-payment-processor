import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAddBreadcrumb = vi.fn();
const mockCaptureMessage = vi.fn();
const mockGetActiveSpan = vi.fn();
const mockGetRootSpan = vi.fn();
const mockStartSpan = vi.fn();

vi.mock("@sentry/react", () => ({
  addBreadcrumb: (...a: unknown[]) => mockAddBreadcrumb(...a),
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  getActiveSpan: () => mockGetActiveSpan(),
  getRootSpan: (...a: unknown[]) => mockGetRootSpan(...a),
  startSpan: (opts: unknown, cb: (s: unknown) => unknown) => mockStartSpan(opts, cb),
}));

import { isExpectedError, captureWarning, withSpan } from "@/shared/utils/telemetry/helpers";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isExpectedError", () => {
  it("returns true for expected patterns", () => {
    expect(isExpectedError("decrypt failed")).toBe(true);
    expect(isExpectedError("open-topic mismatch")).toBe(true);
    expect(isExpectedError("offline")).toBe(true);
    expect(isExpectedError("already settled")).toBe(true);
    expect(isExpectedError("duplicate")).toBe(true);
  });
  it("returns false for unexpected or missing", () => {
    expect(isExpectedError("Cannot read properties of undefined")).toBe(false);
    expect(isExpectedError(undefined)).toBe(false);
  });
});

describe("captureWarning", () => {
  it("calls addBreadcrumb + captureMessage at warning level and sets root span op.sad=true", () => {
    const fakeRootSpan = { setAttribute: vi.fn() };
    const fakeActiveSpan = {};
    mockGetActiveSpan.mockReturnValue(fakeActiveSpan);
    mockGetRootSpan.mockReturnValue(fakeRootSpan);

    captureWarning("chain transport failover", { from: "host", to: "rpc" });

    expect(mockAddBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({ level: "warning", message: "chain transport failover" }));
    expect(mockCaptureMessage).toHaveBeenCalledWith("chain transport failover", expect.objectContaining({ level: "warning" }));
    expect(fakeRootSpan.setAttribute).toHaveBeenCalledWith("op.sad", "true");
  });

  it("never throws even if Sentry internals throw", () => {
    mockGetActiveSpan.mockImplementation(() => { throw new Error("sentry offline"); });
    expect(() => captureWarning("safe call")).not.toThrow();
  });
});

describe("withSpan", () => {
  it("defaults op.sad=false in attributes and returns result", () => {
    const fakeSpan = { setAttribute: vi.fn(), setStatus: vi.fn() };
    mockStartSpan.mockImplementation((_opts: unknown, cb: (s: unknown) => unknown) => cb(fakeSpan));

    const result = withSpan("test", "test.op", () => 42);

    expect(mockStartSpan).toHaveBeenCalledWith(
      expect.objectContaining({ attributes: expect.objectContaining({ "op.sad": "false" }) }),
      expect.any(Function)
    );
    expect(result).toBe(42);
    expect(fakeSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: 1 }));
  });

  it("sets op.sad=true on throw and rethrows", () => {
    const fakeSpan = { setAttribute: vi.fn(), setStatus: vi.fn() };
    mockStartSpan.mockImplementation((_opts: unknown, cb: (s: unknown) => unknown) => cb(fakeSpan));

    expect(() => withSpan("test", "test.op", () => { throw new Error("boom"); })).toThrow("boom");
    expect(fakeSpan.setAttribute).toHaveBeenCalledWith("op.sad", "true");
    expect(fakeSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: 2 }));
  });
});
