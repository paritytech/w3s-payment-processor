// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { resolveNetwork, type NetworkKey } from "@/shared/api/host/networks.ts";
import {
  readBigInt,
  readBool,
  readInt,
  readString,
  readStringRequired,
} from "./shared/utils/env.ts";

export type {
  HostConfig,
  PaymentProcessorConfigInput,
  ProcessorEnvConfig,
  ProtocolEnablement,
  RemoteCredentialBundle,
  ResolvedPayout,
  ResolvedProcessorConfig,
  ResolvedProfile,
  ResolvedV1,
  ResolvedV1Mode,
  ResolvedV1Terminal,
  ResolvedV2,
  ResolvedV2Terminal,
  TelemetryConfig,
  TokenConfig,
  TokenLocation,
} from "./shared/remote-config/types.ts";
export { ProcessorConfigError } from "./shared/remote-config/types.ts";
export { loadProcessorConfig, loadRemoteCredentialBundle } from "./shared/remote-config/processor.ts";

function readEnv() {
  const networkKey = (import.meta.env.VITE_NETWORK as NetworkKey | undefined) ?? undefined;
  const network = resolveNetwork(networkKey);

  const parachainId = readInt("VITE_TOKEN_PARACHAIN_ID", 1500);
  const palletInstance = readInt("VITE_TOKEN_PALLET_INSTANCE", 50);
  const generalIndex = readBigInt("VITE_TOKEN_ASSET_ID", 50_000_413n);

  return {
    networkKey: network.key,
    network,
    token: {
      symbol: readString("VITE_TOKEN_SYMBOL", "CASH"),
      decimals: readInt("VITE_TOKEN_DECIMALS", 6),
      parachainId,
      palletInstance,
      generalIndex,
      location: {
        parents: 1,
        interior: {
          type: "X3" as const,
          value: [
            { type: "Parachain" as const, value: parachainId },
            { type: "PalletInstance" as const, value: palletInstance },
            { type: "GeneralIndex" as const, value: generalIndex },
          ],
        },
      },
    },
    host: {
      productDotNs: readStringRequired("VITE_DOTNS_PRODUCT_DOMAIN"),
      productDerivationIndex: readInt("VITE_HOST_DERIVATION_INDEX", 0),
    },
    readOnlyOrigin: readString(
      "VITE_READ_ONLY_ORIGIN",
      "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    ),
    protocols: {
      v1Enabled: readBool("VITE_V1_LISTENING_ENABLED", true),
      v2Enabled: readBool("VITE_V2_LISTENING_ENABLED", true),
    },
    debug: {
      enabled: readBool("VITE_DEBUG_PANEL", false),
      openByDefault: readBool("VITE_DEBUG_PANEL_OPEN", false),
    },
    remoteCredentials: {
      ipfsGateway: readString(
        "VITE_BULLETIN_IPFS_GATEWAY",
        "https://paseo-bulletin-next-ipfs.polkadot.io",
      ),
      registryAddress: readString(
        "VITE_W3SPAY_REGISTRY_ADDRESS",
        "0xff3b3e8cc1c6bc8a67ae933dc238595c2cc6402b",
      ),
    },
    telemetry: {
      dsn: (import.meta.env.VITE_SENTRY_DSN ?? "").trim(),
      environment: import.meta.env.VITE_SENTRY_ENV ?? import.meta.env.MODE,
      tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? "1") || 1,
    },
  };
}

export const envConfig = readEnv();

export const isDev: boolean = import.meta.env.DEV;
