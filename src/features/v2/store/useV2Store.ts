// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { create } from "zustand";

import type { PaymentRecord } from "@/features/v2/types.ts";
import type { HostProductAccountStatusKind } from "@/shared/api/host/accounts.ts";


export type V2Status = "idle" | "resolving" | "running" | "error";
export type HostAccountStatus = HostProductAccountStatusKind | "checking";
export type HostSignInStatus = "idle" | "requesting" | "rejected" | "unavailable" | "error";

export interface HostAccountUiState {
  status: HostAccountStatus;
  message: string;
  canRequestLogin: boolean;
  signInStatus: HostSignInStatus;
  error?: string;
}

/**
 * Most recent first-time payment detection — set by the engine when a
 * never-seen payment id lands as a `pending` record. Drives the
 * "New payment detected" toast; each event is a fresh object so consumers
 * can diff by reference.
 */
export interface V2PaymentDetection {
  id: string;
  terminalId: string;
  /** Token-unit amount string straight from the payload (e.g. "12.34"). */
  amount: string;
  atMs: number;
  /** Stable payment key: topic + payment id + payload timestamp. */
  key: string;
}


export interface V2MonitorState {
  status: V2Status;
  records: PaymentRecord[];
  /** Whether the host product account is available for claims. */
  claimsEnabled: boolean;
  /** Fail-closed reason (standalone / host unavailable / R6), shown as a Notice. */
  notice?: string;
  /** Count of ignored decrypt/decode failures on watched topics (spam metric). */
  decodeFailures: number;
  error?: string;
  hostAccount: HostAccountUiState;
  requestHostLogin?: () => Promise<void>;
  lastDetection?: V2PaymentDetection;
}

/** Process-wide v2 monitor state. */
export const useV2Store = create<V2MonitorState>(() => ({
  status: "idle",
  records: [],
  claimsEnabled: false,
  hostAccount: {
    status: "standalone",
    message: "Standalone browser mode has no Polkadot host product account.",
    canRequestLogin: false,
    signInStatus: "idle",
  },
  decodeFailures: 0,
}));
