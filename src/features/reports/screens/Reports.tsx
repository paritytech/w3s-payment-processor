// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * DIRECTION A · "Daybook" — Reports. The X running total (a peek, changes
 * nothing), the close-out card (files a numbered Z report and starts a fresh
 * period — wired to the real on-chain-backed commit), and the past-closes list.
 */
import { useState } from "react";

import { fmtDayTime, fmtInt } from "@/shared/utils/ui-format.ts";
import { Money } from "@/shared/components/Money.tsx";
import { Icon } from "@/shared/components/Icon.tsx";
import { Badge, TillDot } from "@/shared/components/indicators.tsx";
import { Btn } from "@/shared/components/controls.tsx";
import { DisplayIf } from "@/shared/components/DisplayIf.tsx";
import type { PaymentStream } from "@/features/dashboard/api/use-payment-stream.ts";
import type { ZHistoryEntry } from "@/features/dashboard/types.ts";

export function Reports({ stream, mobile }: { stream: PaymentStream; mobile: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const { totals, terminals, periodLabel, zHistory } = stream;
  return (
    <div style={{ paddingTop: 20, display: "flex", flexDirection: "column", gap: 26 }}>
      <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", overflow: "hidden" }}>
        <div style={{ padding: mobile ? "18px 18px 4px" : "22px 26px 6px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 11 }}>Current running total · {periodLabel}</div>
            <Money value={totals.grand} size="xl" font="serif" />
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8 }}>{fmtInt(totals.count)} payments since the period opened</div>
          </div>
          <Badge t="blue" icon="eye">A peek — changes nothing</Badge>
        </div>
        <div style={{ padding: mobile ? "14px 18px 8px" : "16px 26px 10px" }}>
          {terminals.map((t) => {
            const d = totals.perTill.get(t.id) ?? { amount: 0, count: 0 };
            return (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-subtle)" }}>
                <TillDot id={t.id} />
                <span style={{ flex: 1, fontSize: 13.5, color: "var(--text-2)", fontWeight: 500 }}>{t.name}</span>
                <span className="mono" style={{ fontSize: 12, color: "var(--faint)", width: 70, textAlign: "right" }}>{d.count}×</span>
                <span style={{ width: 120, textAlign: "right" }}><Money value={d.amount} size="sm" /></span>
              </div>
            );
          })}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0 6px" }}>
            <span style={{ flex: 1, fontSize: 13.5, color: "var(--text-1)", fontWeight: 700 }}>Grand total</span>
            <span style={{ width: 120, textAlign: "right" }}><Money value={totals.grand} size="md" /></span>
          </div>
        </div>
      </section>

      <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface-2)", padding: mobile ? "18px" : "22px 26px" }}>
        <div style={{ display: "flex", alignItems: mobile ? "flex-start" : "center", justifyContent: "space-between", gap: 16, flexDirection: mobile ? "column" : "row" }}>
          <div style={{ maxWidth: 460 }}>
            <h3 style={{ margin: "0 0 6px", fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 19, color: "var(--text-1)", letterSpacing: "-0.02em" }}>Close out the day</h3>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-3)" }}>
              This files today's totals as a numbered report and starts a fresh period. Nothing is deleted — past closes stay in the history below.
            </p>
          </div>
          {confirm ? (
            <div style={{ display: "flex", gap: 8, flex: "0 0 auto" }}>
              <Btn kind="ghost" size="lg" onClick={() => setConfirm(false)}>Cancel</Btn>
              <Btn kind="primary" size="lg" icon="check" onClick={() => { stream.closeOut(); setConfirm(false); }}>Confirm close</Btn>
            </div>
          ) : (
            <Btn kind="primary" size="lg" icon="report" onClick={() => setConfirm(true)} style={{ flex: "0 0 auto" }}>Close out</Btn>
          )}
        </div>
      </section>

      <section>
        <h2 style={{ margin: "0 0 12px", fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 20, color: "var(--text-1)", letterSpacing: "-0.02em" }}>Past closes</h2>
        <DisplayIf condition={zHistory.length === 0}>
          <div style={{ border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-md)", padding: "26px 20px", textAlign: "center", color: "var(--muted)", fontSize: 13, background: "var(--surface)" }}>
            No end-of-day closes yet. Hit “Close out” above to file the first.
          </div>
        </DisplayIf>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {zHistory.map((z) => (
            <ZRow key={z.seq} z={z} stream={stream} />
          ))}
        </div>
      </section>
    </div>
  );
}

function ZRow({ z, stream }: { z: ZHistoryEntry; stream: PaymentStream }) {
  const [open, setOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const badge = PUBLISH_BADGE[z.publishState];

  const onPublish = async () => {
    setPublishing(true);
    try {
      await stream.publishReport(z.seq);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--surface)", overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", width: "100%", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-sans)" }}
      >
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: "var(--text-3)", background: "var(--surface-3)", borderRadius: 6, padding: "3px 8px", flex: "0 0 auto" }}>Z·{String(z.seq).padStart(4, "0")}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-1)" }}>Closed {fmtDayTime(z.closedAtMs)}</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{fmtInt(z.count)} payments</div>
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: badge.color, background: badge.bg, borderRadius: 6, padding: "3px 7px", flex: "0 0 auto", letterSpacing: "0.03em", textTransform: "uppercase" }}>{badge.label}</span>
        <Money value={z.total} size="sm" />
        <Icon name="chevronDown" size={16} stroke={2} style={{ color: "var(--muted)", transform: open ? "rotate(180deg)" : "none", transition: "transform .18s" }} />
      </button>
      <DisplayIf condition={open}>
        <div style={{ padding: "4px 18px 16px", borderTop: "1px solid var(--border-subtle)" }}>
          {stream.terminals.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border-subtle)" }}>
              <TillDot id={t.id} />
              <span style={{ flex: 1, fontSize: 13, color: "var(--text-2)" }}>{t.name}</span>
              <Money value={z.perTill.get(t.id) ?? 0} size="sm" />
            </div>
          ))}
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <DisplayIf condition={z.publishState === "published" && z.cid != null}>
              <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>CID {z.cid}</span>
            </DisplayIf>
            <DisplayIf condition={z.publishState !== "published"}>
              <Btn onClick={onPublish} disabled={publishing} kind="primary" size="sm">
                {publishing ? "Publishing…" : z.publishState === "conflict" ? "Retry publish" : "Publish to chain"}
              </Btn>
            </DisplayIf>
          </div>
          <DisplayIf condition={z.publishState === "conflict"}>
            <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--red)", lineHeight: 1.5 }}>
              On-chain CID for this report doesn't match — another writer claimed the slot. The encrypted
              report stays unreadable to them; retry to confirm.
            </div>
          </DisplayIf>
        </div>
      </DisplayIf>
    </div>
  );
}

const PUBLISH_BADGE: Record<ZHistoryEntry["publishState"], { label: string; color: string; bg: string }> = {
  pending: { label: "Pending", color: "var(--muted)", bg: "var(--surface-3)" },
  published: { label: "Published", color: "var(--green-fg)", bg: "var(--green-bg)" },
  conflict: { label: "Conflict", color: "var(--red)", bg: "rgba(239,68,68,0.12)" },
};
