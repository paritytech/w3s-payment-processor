/**
 * `buildReportDoc` — the versioned wire document for X/Z reports. Asserts the
 * field-copy discipline (local-only `ZReportRecord` fields never leak into the
 * published bytes), the X/Z `seq` semantics, and byte-stable serialization
 * (the contract's idempotent same-cid publish retry depends on it).
 */
import { describe, expect, it } from "vitest";

import { envConfig } from "@/config.ts";
import {
  buildReportDoc,
  PROCESSOR_REPORT_FORMAT,
  PROCESSOR_REPORT_VERSION,
  reportDocToCsv,
} from "@/features/reports/api/report-doc.ts";
import type { ZReportRecord } from "@/features/v1/types.ts";

const RECORD: ZReportRecord = {
  seq: 7,
  fromBlock: 1,
  toBlock: 100,
  lines: [{ terminalId: "t1", payoutHex: `0x${"a".repeat(64)}`, totalPlanck: "3000", count: 2 }],
  grandTotalPlanck: "3000",
  count: 2,
  payments: [
    { paymentId: "p1", terminalId: "t1", amountPlanck: "1000", blockNumber: 5, observedAtMs: 50 },
    { paymentId: "p2", terminalId: "t1", amountPlanck: "2000", blockNumber: 9, observedAtMs: 90, fromHex: `0x${"b".repeat(64)}` },
  ],
  committedAtMs: 123,
  source: "v1",
  publishState: "published",
  cid: "bafkLocalOnly",
};

describe("buildReportDoc", () => {
  it("builds a Z doc carrying seq, the commit time, and the payment line items", () => {
    const doc = buildReportDoc({
      kind: "z",
      groupId: "g-1",
      snapshot: RECORD,
      seq: RECORD.seq,
      generatedAtMs: RECORD.committedAtMs,
    });
    expect(doc.format).toBe(PROCESSOR_REPORT_FORMAT);
    expect(doc.version).toBe(PROCESSOR_REPORT_VERSION);
    expect(doc.kind).toBe("z");
    expect(doc.groupId).toBe("g-1");
    expect(doc.seq).toBe(7);
    expect(doc.generatedAtMs).toBe(RECORD.committedAtMs);
    expect(doc.fromBlock).toBe(1);
    expect(doc.toBlock).toBe(100);
    expect(doc.lines).toEqual(RECORD.lines);
    expect(doc.grandTotalPlanck).toBe("3000");
    expect(doc.count).toBe(2);
    expect(doc.payments).toEqual(
      RECORD.payments.map((p) => ({ ...p, amount: csvAmount(p.amountPlanck) })),
    );
  });

  it("formats each payment's human-readable amount from its planck value", () => {
    const doc = buildReportDoc({ kind: "z", groupId: "g-1", snapshot: RECORD, seq: 7, generatedAtMs: 1 });
    expect(doc.payments.map((p) => p.amount)).toEqual([csvAmount("1000"), csvAmount("2000")]);
  });

  it("omits the seq key entirely for X docs", () => {
    const doc = buildReportDoc({ kind: "x", groupId: "g-1", snapshot: RECORD, generatedAtMs: 5 });
    expect(doc.kind).toBe("x");
    expect("seq" in doc).toBe(false);
  });

  it("never leaks local-only ZReportRecord fields into the doc", () => {
    const doc = buildReportDoc({ kind: "z", groupId: "g-1", snapshot: RECORD, seq: 7, generatedAtMs: 1 });
    for (const key of ["publishState", "cid", "source", "committedAtMs"]) {
      expect(key in doc, `${key} must not leak`).toBe(false);
    }
  });

  it("embeds the configured token metadata", () => {
    const doc = buildReportDoc({ kind: "z", groupId: "g", snapshot: RECORD, seq: 7, generatedAtMs: 1 });
    expect(doc.token).toEqual({ symbol: envConfig.token.symbol, decimals: envConfig.token.decimals });
  });

  it("serializes byte-identically across calls (idempotent publish retries)", () => {
    const args = { kind: "z" as const, groupId: "g", snapshot: RECORD, seq: 7, generatedAtMs: 1 };
    expect(JSON.stringify(buildReportDoc(args))).toBe(JSON.stringify(buildReportDoc(args)));
  });
});

describe("reportDocToCsv", () => {
  const doc = (payments: ZReportRecord["payments"]) =>
    buildReportDoc({
      kind: "z",
      groupId: "g-1",
      snapshot: { ...RECORD, payments },
      seq: 7,
      generatedAtMs: 1,
    });

  it("emits a header plus one row per payment, amounts in token units and planck", () => {
    const csv = reportDocToCsv(doc(RECORD.payments));
    const [header, ...rows] = csv.split("\n");
    expect(header).toBe("payment_id,terminal_id,amount,token,amount_planck,block_number,observed_at,payer");
    expect(rows).toHaveLength(2);
    // 1000 planck @ envConfig decimals — token-unit column derives from formatPlanck.
    expect(rows[0]).toBe(
      `p1,t1,${csvAmount("1000")},${envConfig.token.symbol},1000,5,${new Date(50).toISOString()},`,
    );
    expect(rows[1]!.endsWith(`,0x${"b".repeat(64)}`)).toBe(true);
  });

  it("escapes fields containing commas or quotes", () => {
    const csv = reportDocToCsv(
      doc([{ paymentId: 'p,"x"', terminalId: "till, front", amountPlanck: "1", blockNumber: 1, observedAtMs: 0 }]),
    );
    const row = csv.split("\n")[1]!;
    expect(row.startsWith('"p,""x""","till, front",')).toBe(true);
  });

  it("leaves the block cell empty for coin payments (no block number)", () => {
    const csv = reportDocToCsv(doc([{ paymentId: "c-1", terminalId: "tap-1", amountPlanck: "1000", observedAtMs: 50 }]));
    expect(csv.split("\n")[1]).toBe(
      `c-1,tap-1,${csvAmount("1000")},${envConfig.token.symbol},1000,,${new Date(50).toISOString()},`,
    );
  });

  it("yields only the header for a zero-payment report", () => {
    expect(reportDocToCsv(doc([])).split("\n")).toHaveLength(1);
  });
});

/** Expected token-unit column: integer/fraction split at the configured decimals, trailing zeros trimmed. */
function csvAmount(planck: string): string {
  const scale = 10n ** BigInt(envConfig.token.decimals);
  const whole = BigInt(planck) / scale;
  const fraction = (BigInt(planck) % scale).toString().padStart(envConfig.token.decimals, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}
