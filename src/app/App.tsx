// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { useState } from "react";

import { AppProviders, AppThemeProvider } from "@/app/providers.tsx";
import { MerchantUnlockGate } from "@/app/MerchantUnlockGate.tsx";
import { RootNavigator } from "@/app/navigation/RootNavigator.tsx";
import { envConfig, type ResolvedProcessorConfig } from "@/config.ts";
import { DebugPanel } from "@/shared/api/host/debug/index.ts";
import { ExportFallbackModal } from "@/shared/components/ExportFallbackModal.tsx";


export function App() {
  const [config, setConfig] = useState<ResolvedProcessorConfig | null>(null);
  return (
    <AppThemeProvider>
      <AppBody config={config} onUnlock={setConfig} />
      <ExportFallbackModal />
      {envConfig.debug.enabled ? (
        <DebugPanel config={config} defaultOpen={envConfig.debug.openByDefault} />
      ) : null}
    </AppThemeProvider>
  );
}

function AppBody({
  config,
  onUnlock,
}: {
  config: ResolvedProcessorConfig | null;
  onUnlock: (config: ResolvedProcessorConfig) => void;
}) {
  if (!config) return <MerchantUnlockGate onUnlock={onUnlock} />;
  return (
    <AppProviders config={config}>
      <RootNavigator />
    </AppProviders>
  );
}
