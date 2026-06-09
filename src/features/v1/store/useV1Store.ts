// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { create } from "zustand";

import type { PaymentEvent, ReportState, V1Terminal, ZReportRecord } from "@/features/v1/types.ts";

export type V1Status = "idle" | "resolving" | "running" | "error";
export type BalanceStatus = "idle" | "loading" | "ready" | "error";
export interface V1CatchupProgress {
  fromBlock: number;
  currentBlock: number;
  targetBlock: number;
  processedBlocks: number;
  totalBlocks: number;
  truncated: boolean;
}



export interface V1MonitorState {
  status: V1Status;
  terminals: V1Terminal[];
  /** Recorded events in append order (UI reverses for newest-first). */
  events: PaymentEvent[];
  /** payoutHex (lowercase) → on-chain balance in planck (decimal string). */
  balances: Record<string, string>;
  /** Live balance poll state for the dashboard/reports surfaces. */
  balanceStatus: BalanceStatus;
  balanceError?: string;
  balancesUpdatedAt: number;
  reportState: ReportState;
  zReports: ZReportRecord[];

  fiscalHydrated: boolean;
  /** Highest block scanned in the live tail (best-chain head). */
  finalizedBlock: number;
  /** Highest FINALIZED block seen — payments at/below this are confirmed (final). */
  confirmedBlock: number;
  /** Non-null while resume catchup is scanning historical finalized blocks. */
  catchupProgress: V1CatchupProgress | null;
  /**
   * Set only during catchup — jumps the checkpoint to the catchup target head,
   * abandoning the unscanned tail. Payments in the skipped range are not recorded.
   */
  requestSkipToHead?: () => void;
  error?: string;
  warn?: string;
}

/** Process-wide v1 monitor state. The engine writes via `setState`; UI reads via the hook. */
export const useV1Store = create<V1MonitorState>(() => ({
  status: "idle",
  terminals: [],
  events: [],
  balances: {},
  balanceStatus: "idle",
  balancesUpdatedAt: 0,
  reportState: { periodStartBlock: 0, lastZSeq: 0 },
  zReports: [],
  fiscalHydrated: false,
  finalizedBlock: 0,
  confirmedBlock: 0,
  catchupProgress: null,
}));
