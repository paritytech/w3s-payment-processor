// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { envConfig, type ProtocolEnablement } from "@/config.ts";
import {
  DEFAULT_CHAIN_TRANSPORT,
  getChainTransport,
  setChainTransport as applyChainTransport,
  type ChainTransport,
} from "@/shared/api/chain-transport.ts";
import { dropStaleTransportClients, requestChainRemotePermissions } from "@/shared/api/client.ts";

const STORAGE_KEY = "w3spay-protocol-settings:v1";

export interface ProtocolSettingsDefaults extends ProtocolEnablement {
  chainTransport: ChainTransport;
}

export interface ProtocolSettingsValue extends ProtocolEnablement {
  chainTransport: ChainTransport;
  defaults: ProtocolSettingsDefaults;
  setV1Enabled: (enabled: boolean) => void;
  setV2Enabled: (enabled: boolean) => void;
  setChainTransport: (transport: ChainTransport) => void;
  resetToDefaults: () => void;
}

const ProtocolSettingsContext = createContext<ProtocolSettingsValue | null>(null);

function readStored(defaults: ProtocolEnablement): ProtocolEnablement {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const record = parsed as Record<string, unknown>;
    return {
      v1Enabled: typeof record.v1Enabled === "boolean" ? record.v1Enabled : defaults.v1Enabled,
      v2Enabled: typeof record.v2Enabled === "boolean" ? record.v2Enabled : defaults.v2Enabled,
    };
  } catch {
    return defaults;
  }
}

function saveStored(value: ProtocolEnablement): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* ignore storage failures (private mode / sandbox) */
  }
}

export function ProtocolSettingsProvider({ children }: { children: ReactNode }) {
  const defaults = useMemo<ProtocolSettingsDefaults>(
    () => ({ ...envConfig.protocols, chainTransport: DEFAULT_CHAIN_TRANSPORT }),
    [],
  );
  const [settings, setSettings] = useState<ProtocolEnablement>(() => readStored(envConfig.protocols));
  const [transport, setTransport] = useState<ChainTransport>(getChainTransport);

  useEffect(() => saveStored(settings), [settings]);

  // Ordering: persist + reap stale clients before the state update restarts
  // the engines (fresh effectiveConfig), so their lookups hit the new transport.
  const switchTransport = (next: ChainTransport) => {
    if (next === getChainTransport()) return;
    applyChainTransport(next);
    dropStaleTransportClients();
    // No-op on "host"; on "rpc" it prompts the host for WS access right at the
    // switch (deduped with the engine-restart request via the in-flight cache).
    void requestChainRemotePermissions();
    setTransport(next);
  };

  const value = useMemo<ProtocolSettingsValue>(
    () => ({
      ...settings,
      chainTransport: transport,
      defaults,
      setV1Enabled: (enabled) => setSettings((s) => ({ ...s, v1Enabled: enabled })),
      setV2Enabled: (enabled) => setSettings((s) => ({ ...s, v2Enabled: enabled })),
      setChainTransport: switchTransport,
      resetToDefaults: () => {
        setSettings({ v1Enabled: defaults.v1Enabled, v2Enabled: defaults.v2Enabled });
        switchTransport(defaults.chainTransport);
      },
    }),
    [defaults, settings, transport],
  );

  return <ProtocolSettingsContext.Provider value={value}>{children}</ProtocolSettingsContext.Provider>;
}

export function useProtocolSettings(): ProtocolSettingsValue {
  const ctx = useContext(ProtocolSettingsContext);
  if (!ctx) throw new Error("useProtocolSettings used outside ProtocolSettingsProvider");
  return ctx;
}
