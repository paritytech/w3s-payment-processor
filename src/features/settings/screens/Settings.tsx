// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { Btn } from "@/shared/components/controls.tsx";
import { DisplayIf } from "@/shared/components/DisplayIf.tsx";
import { Icon, type IconName } from "@/shared/components/Icon.tsx";
import { envConfig } from "@/config.ts";
import { useProcessorConfig } from "@/shared/store/useProcessorConfig.tsx";
import { useProtocolSettings } from "@/shared/store/useProtocolSettings.tsx";

/** RPC endpoint hostnames the "Direct RPC" route connects to (build-time network config). */
const RPC_HOSTNAMES = [
  ...new Set(
    [envConfig.network.mainChain.wsUrl, envConfig.network.peopleChain?.wsUrl]
      .filter((url): url is string => Boolean(url))
      .map((url) => {
        try {
          return new URL(url).hostname;
        } catch {
          return url;
        }
      }),
  ),
].join(", ");

export function Settings({ mobile }: { mobile: boolean }) {
  const config = useProcessorConfig();
  const settings = useProtocolSettings();
  const differsFromDefaults =
    settings.v1Enabled !== settings.defaults.v1Enabled ||
    settings.v2Enabled !== settings.defaults.v2Enabled ||
    settings.chainTransport !== settings.defaults.chainTransport;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <SettingsCard
        mobile={mobile}
        icon="settings"
        title="Payment listeners"
        blurb="These switches override the deployment defaults on this device and are saved locally. Turning a listener off stops that monitor; turning it back on starts it again."
      >
        <ProtocolToggle
          title="v1 listening"
          subtitle={`${config.v1.type} · ${settings.defaults.v1Enabled ? "enabled" : "disabled"} by .env`}
          enabled={settings.v1Enabled}
          onChange={settings.setV1Enabled}
        />
        <ProtocolToggle
          title="v2 listening"
          subtitle={`${config.v2.type} · ${settings.defaults.v2Enabled ? "enabled" : "disabled"} by .env`}
          enabled={settings.v2Enabled}
          onChange={settings.setV2Enabled}
        />
      </SettingsCard>

      <SettingsCard
        mobile={mobile}
        icon="activity"
        title="Chain connection"
        blurb="How this device reaches the chain. If one route is down, switch to the other — payment listeners reconnect immediately. Outside a Polkadot host both routes connect directly."
      >
        <div role="radiogroup" aria-label="Chain connection" style={{ display: "grid", gap: 10 }}>
          <TransportOption
            title="Host network"
            subtitle="Through the Polkadot host's chain connection · default"
            selected={settings.chainTransport === "host"}
            onSelect={() => settings.setChainTransport("host")}
          />
          <TransportOption
            title="Direct RPC"
            subtitle={`Straight to ${RPC_HOSTNAMES}`}
            selected={settings.chainTransport === "rpc"}
            onSelect={() => settings.setChainTransport("rpc")}
          />
        </div>
      </SettingsCard>

      <DisplayIf condition={differsFromDefaults}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn kind="ghost" size="sm" icon="refresh" onClick={settings.resetToDefaults}>Reset to defaults</Btn>
        </div>
      </DisplayIf>
    </div>
  );
}

function SettingsCard({
  mobile,
  icon,
  title,
  blurb,
  children,
}: {
  mobile: boolean;
  icon: IconName;
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ padding: mobile ? 18 : 22, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--blue-bg)", color: "var(--blue-fg)", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}>
          <Icon name={icon} size={17} stroke={1.9} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontFamily: "var(--font-serif)", fontWeight: 400, color: "var(--text-1)", letterSpacing: "-0.02em", fontSize: 22 }}>{title}</h2>
          <p style={{ margin: "8px 0 0", color: "var(--text-3)", fontSize: 13.5, lineHeight: 1.55 }}>{blurb}</p>
        </div>
      </div>

      <div style={{ display: "grid", gap: 10, marginTop: 18 }}>{children}</div>
    </section>
  );
}

const optionButtonStyle = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 14,
  padding: "14px 15px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
  color: "var(--text-1)",
  textAlign: "left",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
} as const;

function OptionLabel({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <span style={{ minWidth: 0 }}>
      <span style={{ display: "block", fontSize: 14, fontWeight: 650 }}>{title}</span>
      <span style={{ display: "block", marginTop: 4, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.4 }}>{subtitle}</span>
    </span>
  );
}

function ProtocolToggle({
  title,
  subtitle,
  enabled,
  onChange,
}: {
  title: string;
  subtitle: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button type="button" onClick={() => onChange(!enabled)} aria-pressed={enabled} style={optionButtonStyle}>
      <OptionLabel title={title} subtitle={subtitle} />
      <span
        aria-hidden="true"
        style={{
          width: 42,
          height: 24,
          padding: 2,
          borderRadius: 999,
          background: enabled ? "var(--green)" : "var(--border)",
          flex: "0 0 auto",
          transition: "background .15s",
        }}
      >
        <span
          style={{
            display: "block",
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "white",
            transform: enabled ? "translateX(18px)" : "translateX(0)",
            transition: "transform .15s",
            boxShadow: "0 1px 4px rgba(0,0,0,.22)",
          }}
        />
      </span>
    </button>
  );
}

function TransportOption({
  title,
  subtitle,
  selected,
  onSelect,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect} style={optionButtonStyle}>
      <OptionLabel title={title} subtitle={subtitle} />
      <span
        aria-hidden="true"
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          border: selected ? "6px solid var(--green)" : "2px solid var(--border)",
          background: selected ? "white" : "transparent",
          flex: "0 0 auto",
          transition: "border .15s",
        }}
      />
    </button>
  );
}
