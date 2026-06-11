// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/** Lifecycle pill + v1/v2 source tag for payment rows and the detail sheet. */
import { tone, type Tone } from "@/shared/utils/tone.ts";
import type { PaymentLifecycle } from "@/features/dashboard/types.ts";

const STATUS_META: Record<PaymentLifecycle, { label: string; tone: Tone }> = {
  detected: { label: "Detected", tone: "neutral" },
  finalizing: { label: "Finalizing", tone: "blue" },
  confirmed: { label: "Confirmed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  duplicate: { label: "Duplicate", tone: "amber" },
};

export function statusLabel(status: PaymentLifecycle): string {
  return STATUS_META[status].label;
}

export function PaymentStatusPill({ status, dotOnly }: { status: PaymentLifecycle; dotOnly?: boolean }) {
  const meta = STATUS_META[status];
  const c = tone(meta.tone);
  const pulse = status === "detected" || status === "finalizing";
  if (dotOnly) {
    return (
      <span
        title={meta.label}
        aria-label={meta.label}
        style={{ width: 8, height: 8, borderRadius: "50%", background: c.solid, flex: "0 0 auto", animation: pulse ? "pay-pulse 1.6s ease-in-out infinite" : "none" }}
      />
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px", borderRadius: 999, background: c.bg, color: c.fg, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.solid, animation: pulse ? "pay-pulse 1.6s ease-in-out infinite" : "none" }} />
      {meta.label}
    </span>
  );
}

export function SourceTag({ source }: { source: "v1" | "v2" }) {
  return (
    <span
      className="mono"
      title={source === "v1" ? "RFC-6 direct transfer" : "Coinage tap (statement)"}
      style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", padding: "1px 5px", borderRadius: 5, background: "var(--surface-3)", color: "var(--muted)", border: "1px solid var(--border)", flex: "0 0 auto" }}
    >
      {source.toUpperCase()}
    </span>
  );
}
