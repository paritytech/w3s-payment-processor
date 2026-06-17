// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { countsAsTakings } from "@/features/dashboard/types.ts";
import type { StreamPayment, StreamTerminal, StreamTotals, TerminalTotal } from "@/features/dashboard/types.ts";

/**
 * Roll the open payment stream into the dashboard's display totals — grand
 * total, per-till subtotals, and payment count. Failed v2 claims are skipped
 * (see `countsAsTakings`): they still show in the stream with a red pill, but
 * they brought in no money, so folding them in inflates the running total (a
 * failed $9 sale must not turn $31 into $40).
 *
 * This is the *display* rollup only. The fiscal X/Z close-out
 * (`buildCombinedSnapshot`) deliberately counts failed claims — there the
 * stance is "the customer paid; recovery is the merchant's problem" — so the
 * committed report total can legitimately exceed this running total.
 */
export function computeStreamTotals(
  payments: readonly StreamPayment[],
  terminals: readonly StreamTerminal[],
): StreamTotals {
  const perTill = new Map<string, TerminalTotal>();
  for (const t of terminals) perTill.set(t.id, { amount: 0, count: 0 });
  let grand = 0;
  let count = 0;
  for (const p of payments) {
    if (!countsAsTakings(p)) continue;
    let cell = perTill.get(p.terminalId);
    if (!cell) {
      cell = { amount: 0, count: 0 };
      perTill.set(p.terminalId, cell);
    }
    cell.amount += p.amount;
    cell.count += 1;
    grand += p.amount;
    count += 1;
  }
  return { perTill, grand, count };
}
