// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

// @vitest-environment happy-dom

/**
 * Toast lifetime contract — regression for "toasts never go away":
 * auto-dismiss 3s after each flash (re-armed per flash, even with identical
 * text) and immediate dismiss on tap.
 */
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Toast, type ToastContent } from "@/shared/components/indicators.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let flash: (msg: string) => void;

function Harness() {
  const [toast, setToast] = useState<ToastContent | null>(null);
  flash = (msg: string) => setToast({ msg, tone: "green" });
  const dismiss = useCallback(() => setToast(null), []);
  return <Toast toast={toast} onDismiss={dismiss} />;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("Toast", () => {
  it("renders nothing until flashed, then shows the message", () => {
    expect(container.textContent).toBe("");
    act(() => flash("New payment detected"));
    expect(container.textContent).toContain("New payment detected");
  });

  it("auto-dismisses 3 seconds after a flash", () => {
    act(() => flash("X updated"));
    act(() => vi.advanceTimersByTime(2_999));
    expect(container.textContent).toContain("X updated");
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).toBe("");
  });

  it("re-arms the timer on every flash, including identical text", () => {
    act(() => flash("All payments checked off"));
    act(() => vi.advanceTimersByTime(2_000));
    act(() => flash("All payments checked off"));
    act(() => vi.advanceTimersByTime(2_000));
    expect(container.textContent).toContain("All payments checked off");
    act(() => vi.advanceTimersByTime(1_000));
    expect(container.textContent).toBe("");
  });

  it("dismisses immediately on tap", () => {
    act(() => flash("Day closed out"));
    const el = container.querySelector('[role="status"]');
    expect(el).not.toBeNull();
    act(() => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toBe("");
  });

  it("a dismissed toast does not resurrect from a stale timer", () => {
    act(() => flash("first"));
    act(() => {
      container.querySelector('[role="status"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => flash("second"));
    act(() => vi.advanceTimersByTime(2_999));
    expect(container.textContent).toContain("second");
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).toBe("");
  });
});
