// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import type { AccountId32Hex, H160Hex } from "@/shared/utils/address.ts";
import type { NetworkConfig, NetworkKey } from "@/shared/api/host/networks.ts";

/**
 * XCM Location key for the W3T/CASH foreign asset on the People-system
 * parachain. `Assets.Account(<location>, <ss58>)` is keyed by this, and
 * `Assets.Transferred.asset_id` decodes to the same shape — so it doubles as
 * the event matcher. Shape matches polkadot-api's decoded V4/V5 Location.
 */
export interface TokenLocation {
  parents: number;
  interior: {
    type: "X3";
    value: [
      { type: "Parachain"; value: number },
      { type: "PalletInstance"; value: number },
      { type: "GeneralIndex"; value: bigint },
    ];
  };
}

export interface TokenConfig {
  symbol: string;
  /** Smallest-unit decimals — chain amounts are `10^decimals` sub-units. */
  decimals: number;
  parachainId: number;
  palletInstance: number;
  generalIndex: bigint;
  location: TokenLocation;
}

export interface HostConfig {
  productDotNs: string;
  productDerivationIndex: number;
}

export interface ProtocolEnablement {
  v1Enabled: boolean;
  v2Enabled: boolean;
}

export interface ProcessorEnvConfig {
  networkKey: NetworkKey;
  network: NetworkConfig;
  token: TokenConfig;
  host: HostConfig;
  /** Stable SS58 dry-run origin for revive registry reads. */
  readOnlyOrigin: string;
  /** Build-time defaults for v1/v2 listening; merchant settings can override locally. */
  protocols: ProtocolEnablement;
  debug: { enabled: boolean; openByDefault: boolean };
  /**
   * IPFS gateway used to resolve `ipfs://<cid>` envelope CIDs, and the on-chain
   * registry address the processor reads each group's config CID from at unlock.
   */
  remoteCredentials: { ipfsGateway: string; registryAddress: string };
}

export interface TelemetryConfig {
  /** Trimmed Sentry DSN. Empty string disables telemetry (the SDK never loads). */
  dsn: string;
  environment: string;
  tracesSampleRate: number;
}

export interface PaymentProcessorConfigInput {
  profile: { merchantName: string; merchantId: string };
  v1: {
    type?: string;
    /** On-chain registry read, filtered by groupId. Mutually exclusive with `local`. */
    remote?: { merchantRegistryAddress: string; groupId: string };
    /** Synthesized terminals, no chain read. Mutually exclusive with `remote`. */
    local?: { terminals: { terminalId: string; label?: string; payoutAddress: string }[] };
  };
  v2: {
    type?: string;
    terminals: {
      /** The 32-byte on-wire topic as a 64-character lowercase hex string. */
      topicId: string;
      terminalId: string;
      label?: string;
      payoutAddress: string;
      /** EC private key PEM (P-256), SEC1 or PKCS#8. Supplied ONLY via the encrypted remote envelope, NEVER bundled. */
      pemFile: string;
    }[];
  };
}

export interface ResolvedProfile {
  merchantName: string;
  merchantId: string;
}

export interface ResolvedPayout {
  /** Canonical 32-byte AccountId32. */
  accountId32: Uint8Array;
  ss58: string;
  /** 0x-prefixed lowercase hex — stable storage / map key. */
  hex: AccountId32Hex;
}

export interface ResolvedV1Terminal {
  terminalId: string;
  displayName?: string;
  payout: ResolvedPayout;
}

export type ResolvedV1Mode =
  | { kind: "remote"; merchantRegistryAddress: H160Hex; groupId: string }
  | { kind: "local"; terminals: ResolvedV1Terminal[] };

export interface ResolvedV1 {
  enabled: boolean;
  type: string;
  /** null when v1 is disabled. */
  mode: ResolvedV1Mode | null;
}

export interface ResolvedV2Terminal {
  topicId: string;
  /** 32-byte on-wire topic decoded from `topicId`. */
  topic: Uint8Array;
  /** Lowercase hex of `topic` — the topic→terminal index key. */
  topicHex: string;
  terminalId: string;
  label?: string;
  payout: ResolvedPayout;
  /** 32-byte P-256 private scalar for ECIES decrypt. */
  privKey: Uint8Array;
  /** Uncompressed SEC1 public point (65 bytes). */
  publicKeyUncompressed: Uint8Array;
}

export interface ResolvedV2 {
  enabled: boolean;
  type: string;
  terminals: ResolvedV2Terminal[];
}

export interface ResolvedProcessorConfig {
  profile: ResolvedProfile;
  v1: ResolvedV1;
  v2: ResolvedV2;
  /** True when neither path is active — the UI renders an inert config Notice. */
  inert: boolean;
}

export interface RemoteCredentialBundle {
  /** POS-fleet identifier the merchant enters at unlock; matched against the decrypted envelope. */
  groupId: string;
  config: ResolvedProcessorConfig;
}

export class ProcessorConfigError extends Error {
  override readonly name = "ProcessorConfigError";
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}
