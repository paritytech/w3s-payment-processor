// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * One statement row in the unified stream. Shows a colored lifecycle pill
 * (detected → finalizing → confirmed) and a v1/v2 source tag. Tapping
 * the row opens the payment detail sheet; the check-off tick (v1) stops
 * propagation so it doesn't also open the sheet.
 */
import { useState } from "react";

import { fmtTime } from "@/shared/utils/ui-format.ts";
import { Money } from "@/shared/components/Money.tsx";
import { CheckToggle, TillDot } from "@/shared/components/indicators.tsx";
import { PaymentStatusPill, SourceTag } from "@/features/dashboard/components/PaymentStatus.tsx";
import type { StreamPayment } from "@/features/dashboard/types.ts";

export function PaymentRow({
  p,
  name,
  onToggle,
  onSelect,
  last,
  mobile,
}: {
  p: StreamPayment;
  name: string;
  onToggle: (id: string) => void;
  onSelect: (p: StreamPayment) => void;
  last: boolean;
  mobile?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(p)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(p);
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "13px 16px",
        borderBottom: last ? "none" : "1px solid var(--border-subtle)",
        background: hover ? "var(--hover)" : "transparent",
        transition: "background .12s",
        cursor: "pointer",
      }}
    >
      <span className="mono" style={{ fontSize: 12.5, color: "var(--muted)", width: 56, flex: "0 0 auto" }}>{fmtTime(p.tsMs)}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}>
        <TillDot id={p.terminalId} />
        <span style={{ fontSize: 13.5, color: "var(--text-2)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
        <SourceTag source={p.source} />
      </span>
      {mobile ? <PaymentStatusPill status={p.status} dotOnly /> : <PaymentStatusPill status={p.status} />}
      <Money value={p.amount} size="sm" />
      <span style={{ width: mobile ? 30 : 92, flex: "0 0 auto", display: "flex", justifyContent: "flex-end" }}>
        {p.checkable ? (
          <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>
            <CheckToggle checked={p.checked} onClick={() => onToggle(p.id)} label={!mobile && (p.checked || hover)} />
          </span>
        ) : null}
      </span>
    </div>
  );
}
