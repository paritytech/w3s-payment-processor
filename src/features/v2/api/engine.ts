// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * v2 monitor engine: hydrates durable records, verifies the wallet binding,
 * selects the claim engine, and (in-host only) subscribes to the terminal
 * statement topics, running the orchestrator on each delivered page. Standalone
 * is inert/decode-only: claims disabled, no live statement source.
 */
import { envConfig } from "@/config.ts"
import { detectHostEnvironment, isInHost } from "@/shared/api/host/connection.ts";
import {
  requestHostLogin,
  resolveHostProductAccount,
  subscribeHostAccountConnectionStatus,
  type HostProductAccountStatus,
  type HostLoginStatus,
} from "@/shared/api/host/accounts.ts";
import { createPaymentManager, sandboxTransport, type Subscription } from "@/shared/api/host/host-api.ts";
import { subscribeStatementTopics } from "@/shared/api/host/statement-store.ts";
import { recordBootEvent } from "@/shared/api/host/debug/debug-store.ts";
import { topicKey } from "@/shared/utils/wire/topic.ts";
import { resolveKvStore } from "@/shared/utils/kv-store.ts";
import { playPaymentChime } from "@/shared/utils/chime.ts";
import type { ResolvedV2Terminal } from "@/config.ts"

import { checkWalletBinding } from "@/features/v2/api/binding.ts";
import { resolveClaimEngine, type CoinsTopUpManager } from "@/features/v2/api/claim-engine.ts";
import { indexTerminalsByTopic, ingestPage, type OrchestratorDeps } from "@/features/v2/api/orchestrator.ts";
import { loadRecords, upsertRecord } from "@/features/v2/api/records.ts";
import { useV2Store, type HostAccountUiState, type HostSignInStatus } from "@/features/v2/store/useV2Store.ts";
import { v2PaymentKey, type PaymentRecord } from "@/features/v2/types.ts";

export interface V2MonitorHandle {
  stop(): void;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STANDALONE_NOTICE = "standalone: v2 is decode-only — claims disabled and no live statement source";
const HOST_SIGN_IN_REASON = "Sign in to W3sPay Payment Processor so the Polkadot app can provide its product account.";


export async function startV2Monitor(terminals: ResolvedV2Terminal[], signal?: AbortSignal): Promise<V2MonitorHandle> {
  useV2Store.setState({
    status: "resolving",
    error: undefined,
    hostAccount: {
      status: "checking",
      message: "Checking Polkadot host product account…",
      canRequestLogin: false,
      signInStatus: "idle",
    },
  });
  const kv = resolveKvStore();
  let statementSubscription: Subscription<void> | null = null;
  let accountSubscription: Subscription<void> | null = null;
  let decodeFailures = 0;
  let stopped = false;

  // Mirrors v1's [v1:watch] pattern so the DebugPanel surfaces v2 just as
  // richly: console.log → Console tab (auto-captured); recordBootEvent →
  // Timeline tab. Boot events are reserved for major lifecycle transitions;
  // per-page traffic is console-only to keep the timeline readable.
  const env = detectHostEnvironment();
  const t0 = performance.now();
  const ms = (): number => Math.round(performance.now() - t0);
  const dbg = (
    msg: string,
    phase?: string,
    outcome: "start" | "ok" | "error" = "ok",
  ): void => {
    console.log(`[v2] +${ms()}ms ${msg}`);
    if (phase) recordBootEvent(phase, outcome, msg);
  };
  dbg(
    `begin — terminals=${terminals.length}, env=${env}`,
    "v2:begin",
    "start",
  );

  const handle: V2MonitorHandle = {
    stop() {
      stopped = true;
      statementSubscription?.unsubscribe();
      accountSubscription?.unsubscribe();
      dbg("stopped (teardown)", "v2:stopped", "ok");
    },
  };

  // A replaced/unmounted monitor (StrictMode remount, settings toggle) aborts
  // here, tearing down its subscriptions so two monitors never double-claim.
  if (signal) {
    if (signal.aborted) stopped = true;
    else signal.addEventListener("abort", () => handle.stop(), { once: true });
  }

  try {
    const records = await loadRecords(kv);
    const inHost = isInHost();
    let binding = checkWalletBinding(null, terminals);
    let claimEngine = resolveClaimEngine({
      inHost,
      bindingEnabled: false,
      bindingReason: inHost ? "Checking Polkadot host product account…" : STANDALONE_NOTICE,
      createManager: (): CoinsTopUpManager => createPaymentManager(sandboxTransport),
    });

    const publishRecords = (): void => {
      useV2Store.setState({ records: [...records.values()], decodeFailures });
    };

    // Single shared set spanning the engine's lifetime; protects against the
    // statement-store's gossip re-emission firing concurrent topUp calls for
    // the same payment id while the first claim is still awaiting the host.
    const inflight = new Set<string>();
    // Skip pre-session backlog. 5-minute grace covers a typical merchant
    // app-restart window so a cheque the customer paid just before the
    // restart still gets claimed, but anything older — and the chain coin
    // certainly will be already spent — is dropped before reaching topUp.
    const SESSION_GRACE_MS = 5 * 60_000;
    const sessionStartMs = Date.now() - SESSION_GRACE_MS;
    dbg(
      `session start watermark = ${sessionStartMs} (${new Date(sessionStartMs).toISOString()}); ` +
        `statements with payload timestamp older than this will be skipped as backlog`,
    );
    const deps: OrchestratorDeps = {
      terminalsByTopic: indexTerminalsByTopic(terminals),
      claimEngine,
      binding,
      tokenDecimals: envConfig.token.decimals,
      records,
      inflight,
      sessionStartMs,
      persist: (record: PaymentRecord) => upsertRecord(kv, record),
      // Live UI: re-publish on every record mutation (pending → resolved) so a
      // row appears the instant a tap decodes, not at end-of-page.
      publish: publishRecords,
      onPaymentDetected: (record: PaymentRecord) => {
        dbg(`detected NEW payment id=${record.id} amount=${record.amount} (${record.terminalId}) — pending claim`);
        playPaymentChime();
        useV2Store.setState({
          lastDetection: {
            id: record.id,
            terminalId: record.terminalId,
            amount: record.amount,
            atMs: Date.now(),
            key: v2PaymentKey(record.topicHex, record.id, record.timestampMs),
          },
        });
      },
      onDecodeFailure: (topicHex, reason) => {
        decodeFailures += 1;
        dbg(`decode-failure on ${topicHex.slice(0, 8)}…: ${reason}`);
      },
    };

    const applyHostProductAccount = (
      status: HostProductAccountStatus,
      signInStatus: HostSignInStatus,
    ): void => {
      binding = checkWalletBinding(status.publicKey, terminals);
      const bindingReason = status.kind === "ready" ? binding.reason : status.message;
      claimEngine = resolveClaimEngine({
        inHost,
        bindingEnabled: binding.claimsEnabled,
        bindingReason,
        createManager: (): CoinsTopUpManager => createPaymentManager(sandboxTransport),
      });
      deps.binding = binding;
      deps.claimEngine = claimEngine;

      const hostAccount: HostAccountUiState = {
        status: status.kind,
        message: status.kind === "ready" && bindingReason ? bindingReason : status.message,
        error: status.error,
        canRequestLogin: status.kind === "not-signed-in" || status.kind === "host-unreachable",
        signInStatus,
      };
      useV2Store.setState({
        claimsEnabled: binding.claimsEnabled,
        notice: inHost ? bindingReason : STANDALONE_NOTICE,
        hostAccount,
      });
      dbg(
        `host-account applied: kind=${status.kind}` +
          (status.error ? ` error="${status.error}"` : "") +
          ` → claimsEnabled=${binding.claimsEnabled}` +
          ` bound=${binding.boundTerminalIds.size}/${terminals.length}` +
          (bindingReason ? ` reason="${bindingReason}"` : ""),
      );
    };

    const subscribeStatements = (): void => {
      if (!inHost) {
        dbg("subscribe skipped: standalone (no host statement source)");
        return;
      }
      if (stopped) {
        dbg("subscribe skipped: monitor stopped");
        return;
      }
      if (statementSubscription) {
        dbg("re-subscribing: tearing down existing statement subscription");
        statementSubscription.unsubscribe();
      }
      const topics = terminals.map((terminal) => terminal.topic);
      const topicList =
        terminals
          .map((t) => `${t.terminalId}=${topicKey(t.topic).slice(0, 8)}…`)
          .join(", ") || "<none>";
      dbg(
        `subscribing to ${terminals.length} topic(s): ${topicList}`,
        "v2:subscribe",
        "ok",
      );
      statementSubscription = subscribeStatementTopics(topics, (page) => {
        void (async () => {
          const before = decodeFailures;
          let ours: PaymentRecord[] = [];
          try {
            ours = await ingestPage(page.statements, deps);
          } catch (error) {
            useV2Store.setState({ error: errMessage(error) });
            dbg(`page error: ${errMessage(error)}`);
          } finally {
            publishRecords();
          }
          const decodeDelta = decodeFailures - before;
          const claimed = ours.filter((r) => r.claimStatus === "claimed").length;
          const blocked = ours.filter((r) => r.claimStatus === "claim_blocked").length;
          const failed = ours.filter((r) => r.claimStatus === "claim_failed").length;
          dbg(
            `page: ${page.statements.length} statement(s) — ours=${ours.length} ` +
              `(claimed=${claimed}, blocked=${blocked}, failed=${failed}); ` +
              `decode-failures+=${decodeDelta}`,
          );
          for (const r of ours) {
            dbg(
              `  ${r.terminalId} id=${r.id} amount=${r.amount} → ${r.claimStatus}` +
                (r.claimDiagnostic ? ` — ${r.claimDiagnostic}` : ""),
            );
          }
        })();
      });
    };

    const refreshHostProductAccount = async (
      signInStatus: HostSignInStatus,
      replayStatements: boolean,
    ): Promise<HostProductAccountStatus | null> => {
      if (!inHost) {
        const standalone: HostProductAccountStatus = {
          kind: "standalone",
          publicKey: null,
          message: STANDALONE_NOTICE,
        };
        applyHostProductAccount(standalone, signInStatus);
        return standalone;
      }

      useV2Store.setState((state) => ({
        hostAccount: {
          ...state.hostAccount,
          status: "checking",
          message: "Checking Polkadot host product account…",
          canRequestLogin: false,
          signInStatus,
        },
      }));

      dbg(
        `refresh: querying host product account ` +
          `(dotns=${envConfig.host.productDotNs}, derivation=${envConfig.host.productDerivationIndex})`,
      );
      const status = await resolveHostProductAccount(envConfig.host.productDotNs, envConfig.host.productDerivationIndex);
      if (stopped) {
        dbg("refresh: monitor stopped during host query");
        return null;
      }
      applyHostProductAccount(status, signInStatus);
      if (replayStatements && status.kind === "ready") {
        dbg("host account ready → (re)subscribing to statement topics");
        subscribeStatements();
      }
      return status;
    };

    const runHostLogin = async (): Promise<void> => {
      const currentHostStatus = useV2Store.getState().hostAccount.status;
      dbg(`host-login: requested (currentHostStatus=${currentHostStatus})`);
      useV2Store.setState((state) => ({
        hostAccount: { ...state.hostAccount, signInStatus: "requesting", canRequestLogin: false },
      }));
      if (currentHostStatus === "host-unreachable") {
        const retryStatus = await refreshHostProductAccount("requesting", false);
        if (stopped || retryStatus?.kind !== "not-signed-in") return;
      }

      const result: HostLoginStatus = await requestHostLogin(HOST_SIGN_IN_REASON);
      dbg(`host-login: result=${result}`);
      if (stopped) return;
      if (result === "success" || result === "alreadyConnected") {
        await refreshHostProductAccount("idle", true);
        return;
      }

      const nextStatus: HostSignInStatus =
        result === "rejected" ? "rejected" : result === "unavailable" ? "unavailable" : "error";
      useV2Store.setState((state) => ({
        hostAccount: {
          ...state.hostAccount,
          signInStatus: nextStatus,
          canRequestLogin: state.hostAccount.status === "not-signed-in" || state.hostAccount.status === "host-unreachable",
        },
      }));
    };

    useV2Store.setState({
      records: [...records.values()],
      requestHostLogin: runHostLogin,
    });

    const initialHostStatus = await refreshHostProductAccount("idle", false);
    dbg(`initial host status: ${initialHostStatus?.kind ?? "(none)"}`);
    if (stopped) return handle;
    if (inHost && initialHostStatus?.kind !== "host-unreachable") {
      accountSubscription = subscribeHostAccountConnectionStatus((status) => {
        dbg(`host-account connection: ${status}`);
        if (status === "connected") {
          void refreshHostProductAccount("idle", true);
          return;
        }

        const disconnected: HostProductAccountStatus = {
          kind: "not-signed-in",
          publicKey: null,
          message: "Sign in to the Polkadot app so the host can derive this product account.",
        };
        applyHostProductAccount(disconnected, "idle");
      });
      subscribeStatements();
    } else if (!inHost) {
      dbg("standalone: skipping host account subscription + statement topics");
    } else {
      dbg("host-unreachable: skipping host account subscription + statement topics");
    }

    if (!stopped) {
      useV2Store.setState({ status: "running" });
      dbg(
        `running (records=${records.size}, decodeFailures=${decodeFailures})`,
        "v2:running",
        "ok",
      );
    }
  } catch (error) {
    dbg(`fatal: ${errMessage(error)}`, "v2:fatal", "error");
    useV2Store.setState({ status: "error", error: errMessage(error) });
  }

  return handle;
}
