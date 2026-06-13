import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

import { Toast } from "@/shared/components/indicators.tsx";

describe("Toast", () => {
  it("renders nothing without a message", () => {
    expect(Toast({})).toBeNull();
  });

  it("is tap-dismissible when a dismiss handler is provided", () => {
    const dismiss = vi.fn();
    const el = Toast({ msg: "New payment detected", t: "blue", onDismiss: dismiss });

    expect(isValidElement(el)).toBe(true);
    if (!isValidElement(el)) throw new Error("expected toast element");
    const props = el.props as ReactElement["props"] & { onClick: () => void; "aria-label": string; type: string };

    expect(el.type).toBe("button");
    expect(props.type).toBe("button");
    expect(props["aria-label"]).toBe("Dismiss notification: New payment detected");

    props.onClick();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
