// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const span = { setAttribute: vi.fn(), setStatus: vi.fn() };
  const rootSpan = { setAttribute: vi.fn(), setStatus: vi.fn() };
  const activeSpan = { __active: true };
  type StartSpanOpts = { name: string; op: string; attributes: Record<string, string | number | boolean> };
  return {
    span,
    rootSpan,
    activeSpan,
    startSpan: vi.fn((_opts: StartSpanOpts, cb: (s: typeof span) => unknown) => cb(span)),
    addBreadcrumb: vi.fn(),
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    getActiveSpan: vi.fn(() => activeSpan as unknown),
    getRootSpan: vi.fn(() => rootSpan as unknown),
  };
});

vi.mock("@sentry/react", () => ({
  startSpan: mocks.startSpan,
  addBreadcrumb: mocks.addBreadcrumb,
  captureMessage: mocks.captureMessage,
  captureException: mocks.captureException,
  getActiveSpan: mocks.getActiveSpan,
  getRootSpan: mocks.getRootSpan,
}));

import { captureWarning, isExpectedError, SpanOp, withSpan } from "@/shared/utils/telemetry/index.ts";

beforeEach(() => {
  for (const spy of [
    mocks.startSpan,
    mocks.addBreadcrumb,
    mocks.captureMessage,
    mocks.captureException,
    mocks.getActiveSpan,
    mocks.getRootSpan,
  ]) {
    spy.mockClear();
  }
  mocks.span.setAttribute.mockClear();
  mocks.span.setStatus.mockClear();
  mocks.rootSpan.setAttribute.mockClear();
  mocks.rootSpan.setStatus.mockClear();
  mocks.getActiveSpan.mockReturnValue(mocks.activeSpan);
  mocks.getRootSpan.mockReturnValue(mocks.rootSpan);
});

describe("isExpectedError", () => {
  it("classifies user/external constraints as expected", () => {
    expect(isExpectedError("host unreachable")).toBe(true);
    expect(isExpectedError("Signer rejected the transaction")).toBe(true);
    expect(isExpectedError("device went offline")).toBe(true);
    expect(isExpectedError("insufficient funds for the top-up")).toBe(true);
  });

  it("treats genuine bugs and empty reasons as unexpected", () => {
    expect(isExpectedError("Cannot read properties of undefined")).toBe(false);
    expect(isExpectedError(undefined)).toBe(false);
    expect(isExpectedError(null)).toBe(false);
    expect(isExpectedError("")).toBe(false);
  });
});

describe("captureWarning", () => {
  it("emits a warning breadcrumb + message and flips the active root span sad", () => {
    captureWarning("RPC reconnect", { attempt: 2 });

    expect(mocks.addBreadcrumb).toHaveBeenCalledTimes(1);
    const crumb = mocks.addBreadcrumb.mock.calls[0]![0] as {
      level: string;
      message: string;
      data: Record<string, unknown>;
    };
    expect(crumb.level).toBe("warning");
    expect(crumb.message).toBe("RPC reconnect");
    expect(crumb.data).toEqual({ attempt: 2 });

    expect(mocks.captureMessage).toHaveBeenCalledWith("RPC reconnect", { level: "warning", extra: { attempt: 2 } });
    expect(mocks.rootSpan.setAttribute).toHaveBeenCalledWith("op.sad", "true");
  });

  it("never throws and touches no span when there is no active span", () => {
    mocks.getActiveSpan.mockReturnValue(undefined);
    expect(() => captureWarning("orphan warning")).not.toThrow();
    expect(mocks.rootSpan.setAttribute).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe("withSpan", () => {
  it('defaults op.sad to the string "false" on the start attributes', async () => {
    const result = await withSpan("host ping", SpanOp.HOST_CALL, async () => "ok");

    expect(result).toBe("ok");
    const opts = mocks.startSpan.mock.calls[0]![0];
    expect(opts.op).toBe("host.call");
    expect(opts.attributes["op.sad"]).toBe("false");
  });

  it('flips op.sad to "true" and errors the span when the op throws', async () => {
    await expect(
      withSpan("host ping", SpanOp.HOST_CALL, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(mocks.span.setAttribute).toHaveBeenCalledWith("op.sad", "true");
    expect(mocks.span.setStatus).toHaveBeenCalledWith({ code: 2, message: "boom" });
  });
});
