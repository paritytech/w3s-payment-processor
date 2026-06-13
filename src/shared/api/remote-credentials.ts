// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Remote merchant-credential unlock. The per-merchant secret bundle is NEVER
 * bundled into the SPA: at unlock the merchant enters their `groupId`, the app
 * reads that group's published config CID off the registry contract
 * (`getProcessorConfig`), fetches the encrypted envelope from the IPFS gateway,
 * AES-GCM-decrypts it with the passkey, validates it through
 * `loadRemoteCredentialBundle`, and group-id-checks before any monitor mounts.
 */
import {
  envConfig,
  loadRemoteCredentialBundle,
  ProcessorConfigError,
  type ResolvedProcessorConfig,
} from "@/config.ts";
import {
  decryptCredentialEnvelope,
  CredentialEnvelopeError,
} from "@/shared/utils/wire/credential-envelope.ts";
import { readContract } from "@/shared/api/contracts/read.ts";
import { W3SPayRegistryABI } from "@/features/v1/api/registry-abi.ts";
import { mainChainClient } from "@/shared/api/client.ts";
import { isInHost } from "@/shared/api/host/connection.ts";
import { registerSecret } from "@/shared/utils/telemetry/index.ts";

/** Decoded `getProcessorConfig` tuple — mirrors the Solidity `ProcessorConfigRecord`. */
interface RawProcessorConfigRecord {
  readonly groupId: string;
  readonly cid: string;
  readonly size: number;
  readonly updatedAt: bigint;
  readonly exists: boolean;
}

/**
 * A calm, merchant-facing failure. `message` is the plain-language line shown
 * on the locked gate; `detail` goes behind the technical-details expander —
 * both are guaranteed secret-free.
 */
export class RemoteCredentialsError extends Error {
  override readonly name = "RemoteCredentialsError";
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}

/** Reject envelopes far larger than a real encrypted bundle. */
const MAX_ENVELOPE_BYTES = 256 * 1024;

const IPFS_SCHEME = "ipfs://";

/**
 * Resolve a configured credentials source to a fetchable URL: `ipfs://<cid>`
 * is rewritten through the configured IPFS gateway; `http(s)://` is passed
 * through. Throws `RemoteCredentialsError` on an empty, malformed, or
 * unsupported value.
 */
export function resolveCredentialUrl(url: string, ipfsGateway: string): string {
  const trimmed = url.trim();
  if (trimmed === "") {
    throw new RemoteCredentialsError(
      "this terminal has no credentials source configured",
      "Set VITE_W3SPAY_REGISTRY_ADDRESS and publish a config for this group from w3spay-admin.",
    );
  }
  if (trimmed.startsWith(IPFS_SCHEME)) {
    const cid = trimmed.slice(IPFS_SCHEME.length).replace(/^\/+/, "");
    if (cid === "") {
      throw new RemoteCredentialsError("the credentials source URL is malformed", "ipfs:// URL has no CID.");
    }
    return `${ipfsGateway.replace(/\/+$/, "")}/ipfs/${cid}`;
  }
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  throw new RemoteCredentialsError(
    "the credentials source URL is unsupported",
    "Use an https:// URL or ipfs://<cid>.",
  );
}


export async function resolveProcessorConfigCid(groupId: string): Promise<string> {
  const registryAddress = envConfig.remoteCredentials.registryAddress.trim();
  if (registryAddress === "") {
    throw new RemoteCredentialsError(
      "this terminal has no registry configured",
      "Set VITE_W3SPAY_REGISTRY_ADDRESS for this build.",
    );
  }
  const wsUrl = envConfig.network.mainChain.wsUrl;
  const transport = isInHost() ? "host-bridge" : "direct-ws";
  console.log(`[unlock 1/3] → getProcessorConfig("${groupId}")  registry=${registryAddress}  rpc=${wsUrl}  transport=${transport}`);
  const t0 = performance.now();
  try {

    const client = mainChainClient();
    const [record] = await readContract<[RawProcessorConfigRecord]>(client, {
      address: registryAddress.toLowerCase() as `0x${string}`,
      abi: W3SPayRegistryABI,
      functionName: "getProcessorConfig",
      args: [groupId],
      origin: envConfig.readOnlyOrigin,
      at: "best",
    });
    if (!record.exists || record.cid.trim() === "") {
      throw new RemoteCredentialsError(
        `no configuration published for group "${groupId}"`,
        `getProcessorConfig("${groupId}") returned no record on ${registryAddress}.`,
      );
    }
    console.log(`[unlock 1/3] ← cid=${record.cid}  (${Math.round(performance.now() - t0)}ms)`);
    return record.cid;
  } catch (cause) {
    if (cause instanceof RemoteCredentialsError) throw cause;
    console.log(`[unlock 1/3] ✗ registry read failed (${Math.round(performance.now() - t0)}ms): ${cause instanceof Error ? cause.message : String(cause)}`);
    throw new RemoteCredentialsError(
      "couldn't reach the registry",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

/**
 * Fetch and JSON-parse the encrypted envelope for `groupId`: resolve its CID
 * from the registry contract, rewrite to the IPFS gateway URL, then fetch.
 * Fails closed when the group has no published config, the source is
 * unreachable, oversized, or non-JSON.
 */
export async function fetchCredentialEnvelope(groupId: string): Promise<unknown> {
  const cid = await resolveProcessorConfigCid(groupId);
  const url = resolveCredentialUrl(`ipfs://${cid}`, envConfig.remoteCredentials.ipfsGateway);
  console.log(`[unlock 2/3] → GET ${url}`);
  const t1 = performance.now();
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new RemoteCredentialsError(
      "couldn't reach the credentials source",
      `Network error fetching ${url}.`,
    );
  }
  if (!response.ok) {
    throw new RemoteCredentialsError(
      "the credentials source returned an error",
      `HTTP ${response.status} fetching ${url}.`,
    );
  }
  const text = await response.text();
  console.log(`[unlock 2/3] ← HTTP ${response.status}  ${text.length} bytes  (${Math.round(performance.now() - t1)}ms)`);
  if (text.length > MAX_ENVELOPE_BYTES) {
    throw new RemoteCredentialsError(
      "the credentials envelope is unexpectedly large",
      `Envelope exceeds ${MAX_ENVELOPE_BYTES} bytes — refusing to process.`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RemoteCredentialsError(
      "the credentials source did not return a valid envelope",
      "Response body was not JSON.",
    );
  }
}

export interface ResolveRemoteOptions {
  /** Test/provisioning seam: supply the envelope directly instead of fetching. */
  envelope?: unknown;
}

/**
 * The merchant unlock: look up group → fetch → decrypt → validate → group-id
 * check. Returns a fully-resolved `ResolvedProcessorConfig` (non-null v2
 * `privKey`s) the app mounts against. Throws `RemoteCredentialsError` (locked)
 * on any failure.
 */
export async function resolveRemoteProcessorConfig(
  groupId: string,
  passkey: string,
  options: ResolveRemoteOptions = {},
): Promise<ResolvedProcessorConfig> {
  const wantedGroupId = groupId.trim();
  if (wantedGroupId === "") throw new RemoteCredentialsError("enter your POS group id");
  if (passkey === "") throw new RemoteCredentialsError("enter your unlock passkey");
  // The passkey also re-encrypts Z-reports (app/unlock-creds.ts); redact it from all telemetry.
  registerSecret(passkey);

  console.log(`[unlock] resolveRemoteProcessorConfig  group="${wantedGroupId}"  envelope=${options.envelope ? "supplied" : "fetch"}`);
  const t = performance.now();
  try {
    const envelope = options.envelope ?? (await fetchCredentialEnvelope(wantedGroupId));

    console.log("[unlock 3/3] → decryptCredentialEnvelope");
    const t3 = performance.now();
    let plaintext: Uint8Array;
    try {
      plaintext = await decryptCredentialEnvelope(envelope, passkey);
    } catch (cause) {
      const detail = cause instanceof CredentialEnvelopeError ? cause.message : undefined;
      throw new RemoteCredentialsError("couldn't unlock — check your passkey", detail);
    }
    console.log(`[unlock 3/3] ← decrypted  ${plaintext.length} bytes  (${Math.round(performance.now() - t3)}ms)`);

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    } catch {
      throw new RemoteCredentialsError(
        "the unlocked credentials are malformed",
        "Decrypted payload was not valid JSON.",
      );
    } finally {
      // Best-effort wipe of the decrypted bytes; JS strings can't be erased.
      plaintext.fill(0);
    }

    console.log("[unlock 3/3] → loadRemoteCredentialBundle (validation)");
    let bundleGroupId: string;
    let config: ResolvedProcessorConfig;
    try {
      const bundle = loadRemoteCredentialBundle(json, envConfig.protocols);
      bundleGroupId = bundle.groupId;
      config = bundle.config;
    } catch (cause) {
      const detail = cause instanceof ProcessorConfigError ? cause.message : undefined;
      throw new RemoteCredentialsError("the unlocked credentials are invalid", detail);
    }

    if (bundleGroupId !== wantedGroupId) {
      throw new RemoteCredentialsError(
        "these credentials are for a different POS group",
        `The envelope's group id does not match "${wantedGroupId}".`,
      );
    }

    console.log(`[unlock 3/3] ← bundle valid  groupId="${bundleGroupId}"  total=${Math.round(performance.now() - t)}ms`);
    return config;
  } catch (e) {
    console.log(`[unlock] ✗ failed  ${Math.round(performance.now() - t)}ms  ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
