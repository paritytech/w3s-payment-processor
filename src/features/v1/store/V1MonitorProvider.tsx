// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { useProcessorConfig } from "@/shared/store/useProcessorConfig.tsx";
import { startV1Monitor, type V1MonitorHandle } from "@/features/v1/api/engine.ts";
import { clampPeriodStart, loadReportState, loadZReports } from "@/features/v1/api/persistence.ts";
import { syncPublishedReports } from "@/features/reports/api/report-sync.ts";
import { resolveKvStore } from "@/shared/utils/kv-store.ts";
import { useV1Store } from "@/features/v1/store/useV1Store.ts";

const V1HandleContext = createContext<V1MonitorHandle | null>(null);

/** Starts the v1 engine while v1 is enabled and exposes its handle. */
export function V1MonitorProvider({ children }: { children: ReactNode }) {
  const config = useProcessorConfig();
  const [handle, setHandle] = useState<V1MonitorHandle | null>(null);
  const fiscalHydrated = useV1Store((state) => state.fiscalHydrated);

  useEffect(() => {
    if (!fiscalHydrated) return;
    void syncPublishedReports(resolveKvStore()).catch((error) => {
      console.warn("[reports] sync: published-report pull failed", error);
    });
  }, [fiscalHydrated]);

  useEffect(() => {
    if (!config.v1.enabled || !config.v1.mode) {
      setHandle(null);
      // Fiscal state (Z reports, period cursor) is rail-neutral: hydrate it
      // from KV even without the v1 chain watch, so coin-only (v2) setups can
      // still close out, list past closes, and publish.
      let cancelled = false;
      void (async () => {
        const kv = resolveKvStore();
        const [reportState, zReports] = await Promise.all([loadReportState(kv), loadZReports(kv)]);
        if (cancelled) return;
        useV1Store.setState({
          reportState: clampPeriodStart(reportState ?? { periodStartBlock: 0, lastZSeq: 0 }, zReports),
          zReports,
          fiscalHydrated: true,
        });
      })();
      return () => {
        cancelled = true;
      };
    }
    // One controller per run. Cleanup aborts it, which stops the in-flight
    // backfill and silences its store writes — so a StrictMode remount or a
    // settings toggle never leaves two monitors racing the same catchup state.
    const controller = new AbortController();
    let live: V1MonitorHandle | null = null;
    void startV1Monitor(config.v1.mode, controller.signal).then((resolved) => {
      live = resolved;
      if (controller.signal.aborted) resolved.stop();
      else setHandle(resolved);
    });
    return () => {
      controller.abort();
      setHandle(null);
      live?.stop();
    };
  }, [config]);

  return <V1HandleContext.Provider value={handle}>{children}</V1HandleContext.Provider>;
}

/** v1 live state + UI actions. Actions are no-ops until the engine has started. */
export function useV1Monitor() {
  const state = useV1Store();
  const handle = useContext(V1HandleContext);
  return {
    ...state,
    /** False until the engine handle exists — actions below are no-ops before that. */
    engineReady: handle != null,
    toggleReconcile: handle?.toggleReconcile ?? (async () => {}),
  };
}
