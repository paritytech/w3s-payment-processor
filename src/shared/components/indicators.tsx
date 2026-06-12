// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { DisplayIf } from "@/shared/components/DisplayIf.tsx";
import { Icon, type IconName } from "@/shared/components/Icon.tsx";
import { tillColor } from "@/shared/utils/ui-format.ts";
import { tone, type Tone } from "@/shared/utils/tone.ts";

export type ConnState = "live" | "connecting" | "syncing" | "problem";

export const CONN: Record<ConnState, { label: string; tone: Tone; note: string }> = {
  live: { label: "Live", tone: "green", note: "Watching latest blocks" },
  connecting: { label: "Connecting…", tone: "amber", note: "Opening network subscription" },
  syncing: { label: "Syncing…", tone: "blue", note: "Catching up to latest block" },
  problem: { label: "Connection lost", tone: "red", note: "Trying again automatically" },
};

export function ConnDot({
  state = "live",
  size = 8,
  label,
  sub,
  compact,
}: {
  state?: ConnState;
  size?: number;
  label?: boolean;
  sub?: boolean;
  compact?: boolean;
}) {
  const c = CONN[state];
  const col = tone(c.tone).solid;
  const dot = (
    <span style={{ position: "relative", display: "inline-flex", width: size, height: size, flex: "0 0 auto" }}>
      <DisplayIf condition={state === "live"}>
        <span style={{ position: "absolute", inset: -3, borderRadius: "50%", background: col, opacity: 0.25, animation: "pay-pulse 2s ease-in-out infinite" }} />
      </DisplayIf>
      <span style={{ width: size, height: size, borderRadius: "50%", background: col, animation: state === "connecting" || state === "syncing" ? "pay-pulse 1.1s ease-in-out infinite" : "none" }} />
    </span>
  );
  if (!label) return dot;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      {dot}
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", letterSpacing: "0.01em" }}>{c.label}</span>
        <DisplayIf condition={sub && !compact}>
          <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{c.note}</span>
        </DisplayIf>
      </span>
    </span>
  );
}

export function Badge({
  children,
  t = "neutral",
  icon,
  soft = true,
  style,
}: {
  children: ReactNode;
  t?: Tone;
  icon?: IconName;
  soft?: boolean;
  style?: CSSProperties;
}) {
  const c = tone(t);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px 3px 8px",
        borderRadius: "var(--radius-full)",
        background: soft ? c.bg : "transparent",
        color: c.fg,
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <DisplayIf condition={icon}>
        <Icon name={icon as IconName} size={12.5} stroke={2.1} />
      </DisplayIf>
      {children}
    </span>
  );
}

export function CheckToggle({ checked, onClick, size = 22, label }: { checked: boolean; onClick: () => void; size?: number; label?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={checked ? "Checked off" : "Mark as checked"}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, background: "transparent", border: "none", cursor: "pointer", padding: 0, fontFamily: "var(--font-sans)" }}
    >
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: checked ? "1px solid transparent" : "1.5px solid var(--border-strong)",
          background: checked ? "var(--green-bg)" : "transparent",
          color: "var(--green-fg)",
          transition: "all .15s",
        }}
      >
        <DisplayIf condition={checked}>
          <Icon name="check" size={size * 0.62} stroke={2.4} />
        </DisplayIf>
      </span>
      <DisplayIf condition={label}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: checked ? "var(--green-fg)" : "var(--text-3)" }}>{checked ? "Checked" : "Check off"}</span>
      </DisplayIf>
    </button>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: "50%", background: "var(--text-1)", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}>
      <span style={{ width: size * 0.32, height: size * 0.32, borderRadius: "50%", background: "var(--bg)" }} />
    </span>
  );
}

export function TillDot({ id, size = 7 }: { id: string; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: "50%", background: tillColor(id), flex: "0 0 auto" }} />;
}

export interface ToastContent {
  msg: string;
  tone?: Tone;
}

const TOAST_DISMISS_MS = 3000;

/**
 * Bottom-anchored transient toast. Owns its lifetime: auto-dismisses 3s after
 * each flash (keyed on `toast` object identity, so re-flashing the same text
 * re-arms the timer) and dismisses immediately on tap. `onDismiss` is the
 * single state-clearing path back to the producer.
 */
export function Toast({ toast, onDismiss }: { toast?: ToastContent | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onDismiss, TOAST_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      onClick={onDismiss}
      style={{
        position: "absolute",
        bottom: 18,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 50,
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        padding: "11px 16px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
        fontSize: 13,
        fontWeight: 500,
        color: "var(--text-1)",
        animation: "pay-row-in .25s ease",
        maxWidth: "88%",
        cursor: "pointer",
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: tone(toast.tone ?? "neutral").solid, flex: "0 0 auto" }} />
      {toast.msg}
    </div>
  );
}

/**
 * Top-anchored connection toast: a spinner + "Connecting…" while the processor
 * opens its network subscription, flipping to a "Connected" tick that
 * auto-dismisses once we're live. Driven entirely by the derived ConnState so
 * it tracks the real monitor lifecycle. Tap hides it until the next state
 * change. `busy` suppresses it while a full-screen
 */
export function ConnToast({ conn, busy = false }: { conn: ConnState; busy?: boolean }) {
  const [phase, setPhase] = useState<"connecting" | "connected" | "hidden">(conn === "connecting" ? "connecting" : "hidden");
  const sawConnecting = useRef(conn === "connecting");
  const dismiss = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (conn === "connecting") {
      clearTimeout(dismiss.current);
      sawConnecting.current = true;
      setPhase("connecting");
    } else if (conn === "live" && sawConnecting.current) {
      sawConnecting.current = false;
      setPhase("connected");
      clearTimeout(dismiss.current);
      dismiss.current = setTimeout(() => setPhase("hidden"), 1800);
    } else if (conn === "problem") {
      sawConnecting.current = false;
      clearTimeout(dismiss.current);
      setPhase("hidden");
    }
    // "syncing" keeps the toast as-is so a connecting→syncing→live run reads as one motion.
  }, [conn]);

  useEffect(() => () => clearTimeout(dismiss.current), []);

  if (busy || phase === "hidden") return null;
  const connected = phase === "connected";
  const t: Tone = connected ? "green" : "amber";
  return (
    <div
      role="status"
      aria-live="polite"
      onClick={() => {
        clearTimeout(dismiss.current);
        setPhase("hidden");
      }}
      style={{
        position: "absolute",
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 60,
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        padding: "9px 16px 9px 13px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-full)",
        boxShadow: "var(--shadow-lg)",
        fontSize: 13,
        fontWeight: 600,
        color: "var(--text-1)",
        animation: "pay-row-in .25s ease",
        maxWidth: "88%",
        cursor: "pointer",
      }}
    >
      <Icon
        name={connected ? "check" : "refresh"}
        size={15}
        stroke={2.2}
        style={{ color: tone(t).solid, animation: connected ? "none" : "pay-spin 1.1s linear infinite" }}
      />
      {connected ? "Connected" : "Connecting…"}
    </div>
  );
}
