// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Payment detail sheet — tapping a payment row opens this. Shows the full
 * lifecycle status, v1/v2 source, terminal, amount, block, payer, and the
 * canonical reference (copyable). Duplicate rows get an amber banner telling
 * the merchant the tap was refused and to ring up a new sale. Bottom sheet on
 * mobile, centered modal on desktop; backdrop click + Escape dismiss (mirrors
 * TerminalSheet).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { Icon } from "@/shared/components/Icon.tsx";
import { Money } from "@/shared/components/Money.tsx";
import { fmtDayTime, tillColor } from "@/shared/utils/ui-format.ts";
import { PaymentStatusPill, SourceTag, statusLabel } from "@/features/dashboard/components/PaymentStatus.tsx";
import type { StreamPayment } from "@/features/dashboard/types.ts";

function truncateMid(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
      <span className="eyebrow" style={{ fontSize: 10.5, letterSpacing: "0.1em", color: "var(--muted)", flex: "0 0 auto" }}>{label}</span>
      <span style={{ fontSize: 13, color: "var(--text-2)", textAlign: "right", minWidth: 0 }}>{children}</span>
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }
  return (
    <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border-subtle)" }}>
      <div className="eyebrow" style={{ marginBottom: 6, fontSize: 10.5, letterSpacing: "0.1em", color: "var(--muted)" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="mono" style={{ flex: 1, fontSize: 12.5, color: "var(--text-2)", wordBreak: "break-all", lineHeight: 1.45 }}>{truncateMid(value)}</span>
        <button
          onClick={copy}
          title={copied ? "Copied!" : `Copy ${label.toLowerCase()}`}
          style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: "var(--radius-sm)", border: "none", background: copied ? "var(--green-bg)" : "var(--surface-3)", color: copied ? "var(--green-fg)" : "var(--text-3)", cursor: "pointer", transition: "background .15s, color .15s" }}
        >
          <Icon name={copied ? "check" : "copy"} size={14} stroke={2} />
        </button>
      </div>
    </div>
  );
}

export function PaymentDetailSheet({
  payment,
  terminalName,
  mobile,
  onClose,
}: {
  payment: StreamPayment;
  terminalName: string;
  mobile: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const panelStyle: CSSProperties = mobile
    ? { position: "fixed", bottom: 0, left: 0, right: 0, maxHeight: "85dvh", borderRadius: "var(--radius-xl) var(--radius-xl) 0 0", background: "var(--surface)", boxShadow: "var(--shadow-lg)", overflowY: "auto", zIndex: 210 }
    : { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 420, maxHeight: "80dvh", borderRadius: "var(--radius-lg)", background: "var(--surface)", boxShadow: "var(--shadow-lg)", overflowY: "auto", zIndex: 210 };

  const sourceDesc = payment.source === "v1" ? "RFC-6 direct transfer" : "Coinage tap (statement)";

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200, backdropFilter: "blur(2px)" }} />
      <div style={panelStyle}>
        {mobile && <div style={{ width: 36, height: 4, borderRadius: 99, background: "var(--border-strong)", margin: "12px auto 0" }} />}

        {/* Header — amount + status */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mobile ? "16px 20px 14px" : "20px 20px 14px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: tillColor(payment.terminalId), flex: "0 0 auto" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Money value={payment.amount} size="md" />
            <div style={{ marginTop: 4 }}><PaymentStatusPill status={payment.status} /></div>
          </div>
          <button onClick={onClose} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: "var(--radius-sm)", border: "none", background: "transparent", color: "var(--text-3)", cursor: "pointer", flex: "0 0 auto" }}>
            <Icon name="x" size={16} stroke={2} />
          </button>
        </div>

        <Field label="Status">{statusLabel(payment.status)}</Field>
        <Field label="Type">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <SourceTag source={payment.source} />
            <span style={{ color: "var(--text-3)" }}>{sourceDesc}</span>
          </span>
        </Field>
        <Field label="Terminal">{terminalName}</Field>
        <Field label="Time">{fmtDayTime(payment.tsMs)}</Field>
        {payment.blockNumber !== undefined ? <Field label="Block"><span className="mono">#{payment.blockNumber.toLocaleString()}</span></Field> : null}
        {payment.coinsCount !== undefined ? <Field label="Coins"><span className="mono">{payment.coinsCount}</span></Field> : null}
        {payment.claimNote ? <Field label="Claim note">{payment.claimNote}</Field> : null}
        {payment.payerHex ? <CopyField label="Payer" value={payment.payerHex} /> : null}
        <CopyField label="Reference" value={payment.reference} />

        {mobile && <div style={{ height: "env(safe-area-inset-bottom, 16px)" }} />}
      </div>
    </>
  );
}
