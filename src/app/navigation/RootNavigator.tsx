// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { useState, type ReactNode } from "react";

import { Icon, type IconName } from "@/shared/components/Icon.tsx";
import { Btn } from "@/shared/components/controls.tsx";
import { ConnToast, Toast } from "@/shared/components/indicators.tsx";
import { tone, type Tone } from "@/shared/utils/tone.ts";
import { useIsMobile } from "@/shared/hooks/use-media.ts";
import { DisplayIf } from "@/shared/components/DisplayIf.tsx";
import { usePaymentStream } from "@/features/dashboard/api/use-payment-stream.ts";
import { Today } from "@/features/dashboard/screens/Today.tsx";
import { Feed } from "@/features/feed/screens/Feed.tsx";
import { Reports } from "@/features/reports/screens/Reports.tsx";
import { Settings } from "@/features/settings/screens/Settings.tsx";
import { NetworkStatus } from "@/features/status/screens/NetworkStatus.tsx";
import { Sidebar, TabBar, TopBar } from "@/app/navigation/NavChrome.tsx";
import { ROUTES, type Tab } from "@/app/navigation/routes.ts";
import { StateScreen } from "@/shared/components/StateScreen.tsx";
import type { V1CatchupProgress } from "@/features/v1/store/useV1Store.ts";


export function RootNavigator() {
  const mobile = useIsMobile();
  const stream = usePaymentStream();
  const [tab, setTab] = useState<Tab>(ROUTES.today);

  const showSyncing = !stream.hasLoaded && stream.conn === "syncing";
  const showProblem = !stream.hasLoaded && stream.conn === "problem";
  const signInBusy = stream.hostAccount.signInStatus === "requesting";
  const canRequestHostLogin = stream.hostAccount.canRequestLogin && stream.requestHostLogin !== undefined;
  const hostActionLabel =
    stream.hostAccount.status === "host-unreachable" ? "Retry Polkadot host" : "Sign in to Polkadot";
  const signInNote =
    stream.hostAccount.signInStatus === "rejected"
      ? "Sign-in was cancelled."
      : stream.hostAccount.signInStatus === "unavailable"
        ? "The host bridge is still unavailable."
        : stream.hostAccount.signInStatus === "error"
          ? "The Polkadot app could not start sign-in."
          : undefined;

  return (
    <div className="pay-root" style={{ display: "flex", flexDirection: mobile ? "column" : "row", position: "relative" }}>
      <DisplayIf condition={!mobile}>
        <Sidebar tab={tab} setTab={setTab} stream={stream} />
      </DisplayIf>

      <main className="pay-scroll" style={{ flex: 1, minWidth: 0, overflowY: "auto", overflowX: "hidden", height: "100%", paddingBottom: mobile ? 80 : 0 }}>
        <TopBar mobile={mobile} tab={tab} stream={stream} setTab={setTab} />
        <div style={{ padding: mobile ? "4px 18px 24px" : "8px 40px 48px", maxWidth: 920, margin: "0 auto" }}>
          {showSyncing || showProblem ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "56vh" }}>
              <StateScreen kind={showProblem ? "problem" : "syncing"}>
                <CatchupProgress progress={stream.catchupProgress} onSkip={stream.skipCatchup} centered />
              </StateScreen>
            </div>
          ) : (
            <>
              <CatchupProgress progress={stream.catchupProgress} onSkip={stream.skipCatchup} />
              <DisplayIf condition={stream.claimsNotice}>
                <Banner tone="amber" icon="wallet">
                  <div>Tap payments aren’t being collected right now. {stream.hostAccount.message}</div>
                  <DisplayIf condition={canRequestHostLogin}>
                    <Btn
                      kind="ghost"
                      size="sm"
                      icon="wallet"
                      disabled={signInBusy}
                      onClick={() => {
                        void stream.requestHostLogin?.();
                      }}
                      style={{ marginTop: 10 }}
                    >
                      {signInBusy ? "Checking Polkadot app…" : hostActionLabel}
                    </Btn>
                  </DisplayIf>
                  <DisplayIf condition={signInNote}>
                    <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-3)" }}>{signInNote}</div>
                  </DisplayIf>
                </Banner>
              </DisplayIf>
              <DisplayIf condition={stream.conn === "problem"}>
                <Banner tone="red" icon="activity">Connection lost — reconnecting. New payments will appear as soon as we’re back.</Banner>
              </DisplayIf>
              <DisplayIf condition={tab === ROUTES.today}>
                <Today stream={stream} mobile={mobile} onSeeAll={() => setTab(ROUTES.allPayments)} />
              </DisplayIf>
              <DisplayIf condition={tab === ROUTES.allPayments}>
                <Feed stream={stream} mobile={mobile} />
              </DisplayIf>
              <DisplayIf condition={tab === ROUTES.reports}>
                <Reports stream={stream} mobile={mobile} />
              </DisplayIf>
              <DisplayIf condition={tab === ROUTES.settings}>
                <Settings mobile={mobile} />
              </DisplayIf>
              <DisplayIf condition={tab === ROUTES.network}>
                <NetworkStatus mobile={mobile} onBack={() => setTab(ROUTES.today)} />
              </DisplayIf>
            </>
          )}
        </div>
      </main>

      <DisplayIf condition={mobile}>
        <TabBar tab={tab} setTab={setTab} unchecked={stream.unchecked} />
      </DisplayIf>
      <Toast toast={stream.toast} onDismiss={stream.dismissToast} />
      <ConnToast conn={stream.conn} busy={showSyncing || showProblem} />
    </div>
  );
}

function Banner({ tone: tn, icon, children }: { tone: Tone; icon: IconName; children: ReactNode }) {
  const c = tone(tn);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", borderRadius: "var(--radius-md)", background: c.bg, color: c.fg, marginBottom: 18, fontSize: 13, lineHeight: 1.5 }}>
      <Icon name={icon} size={16} stroke={2} style={{ marginTop: 1, color: c.solid, flex: "0 0 auto" }} />
      <div>{children}</div>
    </div>
  );
}

function CatchupProgress({
  progress,
  centered = false,
  onSkip,
}: {
  progress: V1CatchupProgress | null;
  centered?: boolean;
  onSkip?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!progress) return null;

  const ratio = progress.totalBlocks > 0 ? progress.processedBlocks / progress.totalBlocks : 0;
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const remaining = progress.targetBlock - progress.currentBlock;
  const canSkip = onSkip !== undefined && remaining > 0;
  return (
    <div style={{ width: centered ? "100%" : undefined, maxWidth: centered ? 360 : undefined, margin: centered ? "22px 0 0" : "0 0 18px", padding: "12px 14px", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--surface)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 9 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-2)" }}>
          Syncing payments to block <span className="mono">{progress.targetBlock}</span>
        </div>
        <div className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>{percent}%</div>
      </div>
      <div
        role="progressbar"
        aria-label="Payment catchup progress"
        aria-valuemin={0}
        aria-valuemax={progress.totalBlocks}
        aria-valuenow={progress.processedBlocks}
        style={{ height: 8, borderRadius: 999, background: "var(--surface-3)", overflow: "hidden" }}
      >
        <div style={{ width: `${percent}%`, height: "100%", borderRadius: 999, background: "var(--blue)", transition: "width .18s ease-out" }} />
      </div>
      <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11.5, color: "var(--text-3)" }}>
        <span>
          <span className="mono">{progress.processedBlocks}</span>/<span className="mono">{progress.totalBlocks}</span> blocks
        </span>
        <span>
          current <span className="mono">{progress.currentBlock}</span>
        </span>
      </div>
      <DisplayIf condition={progress.truncated}>
        <div style={{ marginTop: 7, fontSize: 11.5, color: "var(--amber-fg)" }}>Older skipped blocks exceeded the catchup cap.</div>
      </DisplayIf>
      <DisplayIf condition={canSkip}>
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <DisplayIf condition={!confirming}>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-3)", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 600 }}
            >
              <Icon name="chevronRight" size={14} stroke={2.2} />
              Skip to the latest block
            </button>
          </DisplayIf>
          <DisplayIf condition={confirming}>
            <div style={{ fontSize: 11.5, lineHeight: 1.55, color: "var(--amber-fg)", marginBottom: 10 }}>
              Skipping leaves <span className="mono">{remaining}</span> block{remaining === 1 ? "" : "s"} unscanned. Any payments received between block <span className="mono">{progress.currentBlock}</span> and <span className="mono">{progress.targetBlock}</span> won’t be recorded.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn
                kind="ghost"
                size="sm"
                icon="chevronRight"
                onClick={() => {
                  setConfirming(false);
                  onSkip?.();
                }}
                style={{ color: "var(--amber-fg)", borderColor: "var(--amber)" }}
              >
                Skip anyway
              </Btn>
              <Btn kind="subtle" size="sm" onClick={() => setConfirming(false)}>Keep syncing</Btn>
            </div>
          </DisplayIf>
        </div>
      </DisplayIf>
    </div>
  );
}
