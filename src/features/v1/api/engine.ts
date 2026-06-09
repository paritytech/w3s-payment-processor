// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * v1 monitor engine: resolves terminals, hydrates durable state, backfills from
 * the checkpoint, tails the finalized head, and polls balances — writing all
 * live state into `useV1Store`. Returns a handle for UI actions (commit Z,
 * toggle reconcile) and teardown.
 */
import { envConfig } from "@/config.ts"
import {
  mainChainClient,
  peopleChainClient,
  recreatePeopleChainClient,
  requestChainRemotePermissions,
} from "@/shared/api/client.ts";
import type { PolkadotClient } from "polkadot-api";
import { resolveKvStore } from "@/shared/utils/kv-store.ts";
import type { ResolvedV1Mode } from "@/config.ts"

import { fetchTokenBalance, TOKEN_BALANCE_TTL_MS } from "@/features/v1/api/balances.ts";
import { filterNewEvents, indexTerminalsByPayout } from "@/features/v1/api/matching.ts";
import {
  appendTxLog,
  appendZReport,
  loadCheckpoint,
  loadReportState,
  loadTxLog,
  loadZReports,
  saveCheckpoint,
  saveReportState,
  setEventReconciled,
} from "@/features/v1/api/persistence.ts";
import { resolveV1Terminals } from "@/features/v1/api/registry.ts";
import { commitZReport } from "@/features/v1/api/reports.ts";
import { createZReportPublisher } from "@/features/reports/api/zreport-publisher.ts";
import type { TxStatus } from "@/shared/api/contracts/watch-transaction.ts";
import { useV1Store } from "@/features/v1/store/useV1Store.ts";
import { startV1Watch } from "@/features/v1/api/watch.ts";
import {
  startWatchSupervisor,
  type WatchStarter,
  type WatchSupervisor,
} from "@/features/v1/api/watch-resilience.ts";
import { recordBootEvent } from "@/shared/api/host/debug/debug-store.ts";

export interface V1MonitorHandle {
  stop(): void;
  commitZReport(): Promise<void>;
  /** Encrypt + publish a committed Z report's CID on-chain (best-effort; retryable). */
  publishZReport(seq: number, onStatus?: (status: TxStatus) => void): Promise<void>;
  toggleReconcile(paymentId: string): Promise<void>;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startV1Monitor(mode: ResolvedV1Mode, signal?: AbortSignal): Promise<V1MonitorHandle> {
  const t0 = performance.now();
  const dbg = (msg: string, phase?: string, outcome: "start" | "ok" | "error" = "ok") => {
    console.log(`[v1] +${Math.round(performance.now() - t0)}ms ${msg}`);
    if (phase) recordBootEvent(phase, outcome, msg);
  };
  dbg(`begin (mode=${mode.kind})`, "begin", "start");
  useV1Store.setState({ status: "resolving", error: undefined, catchupProgress: null });
  const kv = resolveKvStore();
  const knownIds = new Set<string>();
  let stopped = false;
  let watchSupervisor: WatchSupervisor | null = null;
  // Updated by `onBlock` so the supervisor's restart path always backfills
  // from the most-recently processed block, not the boot-time checkpoint.
  let latestCheckpoint: number | undefined;
  let balanceTimer: ReturnType<typeof setInterval> | undefined;

  const publishReport = createZReportPublisher(kv);

  const handle: V1MonitorHandle = {
    stop() {
      dbg("handle.stop() called");
      stopped = true;
      if (balanceTimer) clearInterval(balanceTimer);
      watchSupervisor?.stop();
      useV1Store.setState({ requestSkipToHead: undefined });
    },
    async commitZReport() {
      const state = useV1Store.getState();
      const { record, nextState } = commitZReport(
        state.reportState,
        state.events,
        state.finalizedBlock,
        state.terminals,
        Date.now(),
      );
      await appendZReport(kv, record);
      await saveReportState(kv, nextState);
      useV1Store.setState({ zReports: [...state.zReports, record], reportState: nextState });
      // Best-effort on-commit auto-publish; failures leave it `pending` for a
      // manual retry from the Reports screen.
      void publishReport(record.seq).catch((error) =>
        dbg(`auto-publish seq ${record.seq} failed: ${errMessage(error)}`),
      );
    },
    publishZReport: publishReport,
    async toggleReconcile(paymentId: string) {
      const state = useV1Store.getState();
      const target = state.events.find((event) => event.paymentId === paymentId);
      if (!target) return;
      const reconciled = !target.reconciled;
      await setEventReconciled(kv, paymentId, reconciled);
      useV1Store.setState({
        events: state.events.map((event) => (event.paymentId === paymentId ? { ...event, reconciled } : event)),
      });
    },
  };

  // A replaced/unmounted monitor (e.g. StrictMode remount) aborts here: stop the
  // in-flight backfill and silence its store writes so two monitors never race.
  if (signal) {
    if (signal.aborted) stopped = true;
    else signal.addEventListener("abort", () => handle.stop(), { once: true });
  }

  try {
    await requestChainRemotePermissions();
    dbg("chain remote permissions granted", "permissions");
    const terminals = await resolveV1Terminals(mode, mainChainClient, envConfig.readOnlyOrigin);
    const terminalsByPayoutHex = indexTerminalsByPayout(terminals);
    dbg(`resolved ${terminals.length} terminal(s); loading durable state…`, "terminals");

    const [events, checkpoint, savedReportState, zReports] = await Promise.all([
      loadTxLog(kv),
      loadCheckpoint(kv),
      loadReportState(kv),
      loadZReports(kv),
    ]);
    latestCheckpoint = checkpoint;
    dbg(`durable state loaded: events=${events.length}, checkpoint=${checkpoint ?? "none"}, zReports=${zReports.length}`, "durable");
    for (const event of events) knownIds.add(event.paymentId);
    useV1Store.setState({
      terminals,
      events,
      reportState: savedReportState ?? { periodStartBlock: 0, lastZSeq: 0 },
      zReports,
    });

    const peopleClient = peopleChainClient();
    if (!peopleClient) {
      dbg("no People chain configured", "people-client", "error");
      useV1Store.setState({ status: "error", error: "no People chain configured for the active network" });
      return handle;
    }
    dbg("people chain client ready", "people-client");

    const token = {
      parachainId: envConfig.token.parachainId,
      palletInstance: envConfig.token.palletInstance,
      generalIndex: envConfig.token.generalIndex,
    };

    // Look up the people-chain client through the cache on every refresh.
    // The resilience supervisor calls `recreatePeopleChainClient` on each
    // restart (see below) to dislodge a stale `chainHead_v1_follow` after a
    // host wake; that destroys the cached client out from under any closure
    // that captured it. Re-resolving each call routes through the fresh one
    // and lets the destroyed client's error surface as a balance error
    // instead of a stuck poll loop.
    const refreshBalances = async (): Promise<void> => {
      if (stopped) return;
      const client = peopleChainClient();
      if (!client) return;
      const current = useV1Store.getState();
      useV1Store.setState({
        balanceStatus: current.balancesUpdatedAt === 0 ? "loading" : current.balanceStatus,
        balanceError: undefined,
      });

      const entries = await Promise.all(
        terminals.map(async (terminal) => {
          const key = terminal.payout.hex.toLowerCase();
          try {
            const balance = await fetchTokenBalance(client, terminal.payout.accountId32);
            return { ok: true, key, balance: balance.toString() } as const;
          } catch (error) {
            return { ok: false, key, error: errMessage(error) } as const;
          }
        }),
      );
      if (stopped) return;

      const state = useV1Store.getState();
      const balances = { ...state.balances };
      let successCount = 0;
      let firstError: string | undefined;
      for (const entry of entries) {
        if (entry.ok) {
          balances[entry.key] = entry.balance;
          successCount += 1;
        } else {
          firstError ??= `${entry.key}: ${entry.error}`;
        }
      }
      useV1Store.setState({
        balances,
        balanceStatus: firstError && successCount === 0 ? "error" : "ready",
        balanceError: firstError,
        balancesUpdatedAt: successCount > 0 || terminals.length === 0 ? Date.now() : state.balancesUpdatedAt,
      });
    };
    void refreshBalances();
    balanceTimer = setInterval(() => void refreshBalances(), TOKEN_BALANCE_TTL_MS);

    dbg(`starting watch (checkpoint=${checkpoint ?? "none"})`, "watch", "start");
    // Resilience: on each restart (visibility-resume or watchdog-stale), the
    // people-chain PAPI client is destroyed and recreated so a fresh
    // `chainHead_v1_follow` runs against the host's now-reconnected WS. The
    // first call short-circuits to the already-cached client created during
    // setup above so the boot path doesn't pay the destroy/recreate tax.
    let isFirstStart = true;
    const startWatch: WatchStarter = async (loopSignal) => {
      let client: PolkadotClient | null;
      if (isFirstStart) {
        isFirstStart = false;
        client = peopleClient;
      } else {
        dbg("recreate people-chain client (fresh chainHead follow)", "watch-restart");
        client = recreatePeopleChainClient();
      }
      if (!client) throw new Error("people chain unavailable on watch restart");
      return startV1Watch(
        {
          client,
          token,
          terminalsByPayoutHex,
          onBlock: async (newEvents, blockNumber) => {
            if (stopped) return;
            const fresh = filterNewEvents(knownIds, newEvents);
            dbg(`onBlock #${blockNumber} (raw ${newEvents.length}, fresh ${fresh.length})`);
            if (fresh.length > 0) {
              for (const event of fresh) knownIds.add(event.paymentId);
              await appendTxLog(kv, fresh);
            }
            await saveCheckpoint(kv, blockNumber);
            latestCheckpoint = blockNumber;
            watchSupervisor?.noteBlock();
            const state = useV1Store.getState();
            // First processed block seeds the open fiscal period start.
            const periodStartBlock = state.reportState.periodStartBlock === 0 ? blockNumber : state.reportState.periodStartBlock;
            const nextReportState =
              periodStartBlock === state.reportState.periodStartBlock
                ? state.reportState
                : { ...state.reportState, periodStartBlock };
            if (nextReportState !== state.reportState) await saveReportState(kv, nextReportState);
            useV1Store.setState({
              events: fresh.length > 0 ? [...state.events, ...fresh] : state.events,
              finalizedBlock: blockNumber,
              reportState: nextReportState,
              // Live blocks: any prior watch error is stale.
              error: undefined,
            });
            if (fresh.length > 0) void refreshBalances();
          },
          onWarn: (warn) => {
            dbg(`onWarn: ${warn}`);
            useV1Store.setState({ warn });
          },
          onError: (error) => {
            dbg(`onError: ${errMessage(error)}`, "watch", "error");
            useV1Store.setState({ error: errMessage(error) });
          },
          onCatchupProgress: (catchupProgress) => {
            if (!stopped) useV1Store.setState({ catchupProgress });
          },
          onSkipAvailable: (skip) => {
            if (!stopped) useV1Store.setState({ requestSkipToHead: skip ?? undefined });
          },
          onFinalized: (blockNumber) => {
            if (stopped) return;
            const current = useV1Store.getState().confirmedBlock;
            if (blockNumber > current) useV1Store.setState({ confirmedBlock: blockNumber });
          },
          backfillWsUrl: envConfig.network.peopleChain?.wsUrl,
          signal: loopSignal,
        },
        latestCheckpoint,
      );
    };

    watchSupervisor = await startWatchSupervisor({
      start: startWatch,
      log: (msg) => dbg(`[resilience] ${msg}`),
    });
    dbg("watch started → status running", "running", "ok");

    if (!stopped) useV1Store.setState({ status: "running", catchupProgress: null, requestSkipToHead: undefined });
  } catch (error) {
    dbg(`FAILED: ${errMessage(error)}`, "error", "error");
    if (!stopped) useV1Store.setState({ status: "error", error: errMessage(error), catchupProgress: null, requestSkipToHead: undefined });
  }

  return handle;
}
