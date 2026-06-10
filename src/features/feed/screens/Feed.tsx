// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * DIRECTION A · "Daybook" — All payments. One stream, newest first, grouped by
 * the hour like a statement. Status filter (all / to-check / checked) acts on
 * the checkable v1 rows; terminal chips filter the whole stream.
 */
import { useMemo, useState, type ReactNode } from "react";

import { envConfig } from "@/config.ts";
import { fmtCash, fmtDayHour, groupByHour } from "@/shared/utils/ui-format.ts";
import { Btn, Segmented } from "@/shared/components/controls.tsx";
import { TillDot } from "@/shared/components/indicators.tsx";
import { DisplayIf } from "@/shared/components/DisplayIf.tsx";
import { EmptyState } from "@/features/dashboard/components/EmptyState.tsx";
import { PaymentRow } from "@/features/dashboard/components/PaymentRow.tsx";
import { PaymentDetailSheet } from "@/features/dashboard/components/PaymentDetailSheet.tsx";
import type { StreamPayment } from "@/features/dashboard/types.ts";
import type { PaymentStream } from "@/features/dashboard/api/use-payment-stream.ts";

type StatusFilter = "all" | "unchecked" | "checked";
type ScopeFilter = "period" | "history";

export function Feed({ stream, mobile }: { stream: PaymentStream; mobile: boolean }) {
  const [fScope, setFScope] = useState<ScopeFilter>("period");
  const [fStatus, setFStatus] = useState<StatusFilter>("all");
  const [fTill, setFTill] = useState<string>("all");
  const [selected, setSelected] = useState<StreamPayment | null>(null);
  const nameOf = new Map(stream.terminals.map((t) => [t.id, t.name]));

  // History rows are all older than the open period, but the two rails'
  // timestamps can interleave around a close — re-sort the union.
  const source = useMemo(
    () =>
      fScope === "history"
        ? [...stream.payments, ...stream.historyPayments].sort((a, b) => b.tsMs - a.tsMs)
        : stream.payments,
    [fScope, stream.payments, stream.historyPayments],
  );
  const feed = useMemo(
    () =>
      source.filter((p) => {
        if (fTill !== "all" && p.terminalId !== fTill) return false;
        if (fStatus === "unchecked") return p.checkable && !p.checked;
        if (fStatus === "checked") return p.checkable && p.checked;
        return true;
      }),
    [source, fStatus, fTill],
  );
  // Multi-day history needs day-qualified group labels or hours from
  // different days coalesce.
  const groups = useMemo(
    () => groupByHour(feed, fScope === "history" ? fmtDayHour : undefined),
    [feed, fScope],
  );

  return (
    <div style={{ paddingTop: 18 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 18 }}>
        <Segmented
          value={fScope}
          onChange={(id) => setFScope(id as ScopeFilter)}
          size="sm"
          items={[
            { id: "period", label: "This period" },
            { id: "history", label: "All history" },
          ]}
        />
        <Segmented
          value={fStatus}
          onChange={(id) => setFStatus(id as StatusFilter)}
          size="sm"
          items={[
            { id: "all", label: "All" },
            { id: "unchecked", label: "To check", count: stream.unchecked },
            { id: "checked", label: "Checked" },
          ]}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
          <TillChip active={fTill === "all"} onClick={() => setFTill("all")}>All terminals</TillChip>
          {stream.terminals.map((t) => (
            <TillChip key={t.id} id={t.id} active={fTill === t.id} onClick={() => setFTill(t.id)}>{t.name}</TillChip>
          ))}
        </div>
        <DisplayIf condition={stream.unchecked > 0 && !mobile}>
          <Btn kind="subtle" size="sm" icon="check" onClick={stream.checkAll}>Check all</Btn>
        </DisplayIf>
      </div>

      <DisplayIf condition={feed.length === 0}>
        <EmptyState filtered />
      </DisplayIf>
      <DisplayIf condition={feed.length > 0}>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {groups.map((g) => (
            <div key={g.hour}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <span className="eyebrow">{g.hour}</span>
                <span style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
                  {fmtCash(g.items.reduce((s, p) => s + p.amount, 0))} {envConfig.token.symbol}
                </span>
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--surface)" }}>
                {g.items.map((p, i) => (
                  <PaymentRow key={p.id} p={p} name={nameOf.get(p.terminalId) ?? p.terminalId} onToggle={stream.toggleCheck} onSelect={setSelected} last={i === g.items.length - 1} mobile={mobile} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </DisplayIf>
      {selected && (
        <PaymentDetailSheet
          payment={selected}
          terminalName={nameOf.get(selected.terminalId) ?? selected.terminalId}
          mobile={mobile}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function TillChip({ children, id, active, onClick }: { children: ReactNode; id?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderRadius: "var(--radius-full)",
        border: `1px solid ${active ? "var(--border-strong)" : "var(--border)"}`,
        cursor: "pointer",
        background: active ? "var(--hover-strong)" : "transparent",
        color: active ? "var(--text-1)" : "var(--text-3)",
        fontSize: 12.5,
        fontWeight: 600,
        fontFamily: "var(--font-sans)",
        transition: "all .14s",
        whiteSpace: "nowrap",
      }}
    >
      <DisplayIf condition={id}>
        <TillDot id={id as string} />
      </DisplayIf>
      {children}
    </button>
  );
}
