// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Host account access. v2 claims depend on a product account derived by the
 * Polkadot host for this product; anonymous host sessions return NotConnected,
 * so the UI needs a precise "sign in" state instead of a generic disabled
 * claim notice.
 */
import { connectToHost, isInHost } from "@/shared/api/host/connection.ts";
import { createAccountsProvider, sandboxTransport } from "@/shared/api/host/host-api.ts";
import type { AccountConnectionStatus, Subscription } from "@/shared/api/host/host-api.ts";
import { AccountId } from "@polkadot-api/substrate-bindings";
import type { PolkadotSigner } from "polkadot-api";

export type HostProductAccountStatusKind =
  | "standalone"
  | "host-unreachable"
  | "not-signed-in"
  | "rejected"
  | "domain-not-valid"
  | "ready"
  | "error";

export interface HostProductAccountStatus {
  kind: HostProductAccountStatusKind;
  publicKey: Uint8Array | null;
  message: string;
  error?: string;
}

export type HostLoginStatus = "success" | "alreadyConnected" | "rejected" | "unavailable" | "error";

function credentialsFailureStatus(error: unknown): HostProductAccountStatus {
  const err = error as { tag?: string; message?: string; payload?: { reason?: string } };
  const tag = err.tag ?? "";
  const reason = err.payload?.reason ?? err.message ?? String(error);

  if (tag.endsWith("NotConnected")) {
    return {
      kind: "not-signed-in",
      publicKey: null,
      message: "Sign in to the Polkadot app so the host can derive this product account.",
      error: reason,
    };
  }
  if (tag.endsWith("Rejected")) {
    return {
      kind: "rejected",
      publicKey: null,
      message: "Product-account access was rejected in the Polkadot app.",
      error: reason,
    };
  }
  if (tag.endsWith("DomainNotValid")) {
    return {
      kind: "domain-not-valid",
      publicKey: null,
      message: "The configured product DOTNS is not valid for host product-account derivation.",
      error: reason,
    };
  }

  return {
    kind: "error",
    publicKey: null,
    message: "The Polkadot app could not provide this product account.",
    error: reason,
  };
}

/**
 * Resolve the host's bound product account public key (32-byte AccountId32).
 * Fail-closed but diagnostic: callers can distinguish "host unreachable" from
 * "user is not signed in" and offer the RFC-0009 login CTA.
 */
export async function resolveHostProductAccount(
  dotNsIdentifier: string,
  derivationIndex: number,
): Promise<HostProductAccountStatus> {
  if (!isInHost()) {
    return {
      kind: "standalone",
      publicKey: null,
      message: "Standalone browser mode has no Polkadot host product account.",
    };
  }

  const ready = await connectToHost();
  if (!ready) {
    return {
      kind: "host-unreachable",
      publicKey: null,
      message: "Polkadot host bridge is not reachable yet. Open this SPA inside the Polkadot app and keep it signed in.",
    };
  }

  const accounts = createAccountsProvider(sandboxTransport);
  return accounts.getProductAccount(dotNsIdentifier, derivationIndex).match(
    (account) => ({
      kind: "ready",
      publicKey: account.publicKey,
      message: "Host product account is available.",
    }),
    (error) => {
      const status = credentialsFailureStatus(error);
      console.warn(`[host] getProductAccount failed: ${status.error ?? status.message}`);
      return status;
    },
  );
}

/** Back-compat seam for callers that only need the raw key. */
export async function getBoundProductAccountKey(
  dotNsIdentifier: string,
  derivationIndex: number,
): Promise<Uint8Array | null> {
  const status = await resolveHostProductAccount(dotNsIdentifier, derivationIndex);
  return status.publicKey;
}

export async function requestHostLogin(reason: string): Promise<HostLoginStatus> {
  if (!isInHost()) return "unavailable";
  const ready = await connectToHost();
  if (!ready) return "unavailable";

  const accounts = createAccountsProvider(sandboxTransport);
  return accounts.requestLogin(reason).match(
    (status) => status,
    (error) => {
      const err = error as { message?: string; payload?: { reason?: string } };
      console.warn(`[host] requestLogin failed: ${err.payload?.reason ?? err.message ?? String(error)}`);
      return "error";
    },
  );
}

export function subscribeHostAccountConnectionStatus(
  callback: (status: AccountConnectionStatus) => void,
): Subscription<void> | null {
  if (!isInHost()) return null;
  const accounts = createAccountsProvider(sandboxTransport);
  return accounts.subscribeAccountConnectionStatus(callback);
}

const SS58_PREFIX = 42;

export interface ProductAccountSigner {
  readonly signer: PolkadotSigner;
  /** SS58 (prefix 42) — the dry-run origin + account-mapping key for contract writes. */
  readonly walletAddress: string;
}

/**
 * Build a host-backed `PolkadotSigner` for the product account plus its SS58
 * address, for the processor's only on-chain write (Z reports). The host signs
 * each payload via the accounts provider — mirrors the admin wallet's
 * build-signer step. MUST be called in the authed tree (post host sign-in),
 * where the product-account public key is already resolved.
 */
export function getProductAccountSigner(
  dotNsIdentifier: string,
  derivationIndex: number,
  publicKey: Uint8Array,
): ProductAccountSigner {
  const accounts = createAccountsProvider(sandboxTransport);
  const signer = accounts.getProductAccountSigner(
    { dotNsIdentifier, derivationIndex, publicKey },
    "createTransaction",
  );
  return { signer, walletAddress: AccountId(SS58_PREFIX).dec(publicKey) };
}
