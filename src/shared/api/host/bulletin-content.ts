// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";

import { isInHost } from "@/shared/api/host/connection.ts";
import { preimageManager } from "@/shared/api/host/host-api.ts";
import { BLAKE2B_256_LENGTH } from "@/shared/utils/wire/cid.ts";

/** Default wall-clock budget for one host preimage lookup. */
export const PREIMAGE_LOOKUP_TIMEOUT_MS = 30_000;

/**
 * Outcome of resolving Bulletin content through the host transport.
 *
 * `no-host` is the only outcome that licenses an HTTPS fallback — a host
 * environment MUST NOT reach a public gateway for Bulletin content.
 */
export type BulletinPreimageResult =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "no-host" };

/** Subset of the host preimage manager this module depends on. Test seam. */
export interface PreimageLookup {
  lookup(
    key: `0x${string}`,
    callback: (preimage: Uint8Array | null) => void,
  ): { unsubscribe: () => void };
}

export interface FetchBulletinPreimageOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Host-presence guard. Defaults to `isInHost`. */
  readonly inHost?: () => boolean;
  /** Preimage transport. Defaults to the host-api singleton. */
  readonly preimage?: PreimageLookup;
}

export type FetchBulletinPreimage = (
  cid: string,
  opts?: FetchBulletinPreimageOptions,
) => Promise<BulletinPreimageResult>;

/**
 * Resolve Bulletin content addressed by `cid` over the host transport
 * (`window.truapi`) instead of an HTTPS IPFS gateway.
 *
 * Bulletin stores payloads as preimages keyed by their blake2b-256 hash,
 * which is exactly the multihash digest of the raw-codec CIDv1 — so the
 * lookup key is `CID.parse(cid).multihash.digest`. The returned bytes are
 * re-hashed against that digest before they are handed back, so a host that
 * serves the wrong payload cannot smuggle it past content addressing.
 */
export const fetchBulletinPreimage: FetchBulletinPreimage = (cid, opts = {}) => {
  const inHost = opts.inHost ?? isInHost;
  if (!inHost()) return Promise.resolve({ kind: "no-host" });

  let digest: Uint8Array;
  let key: `0x${string}`;
  try {
    digest = CID.parse(cid).multihash.digest;
    key = bytesToHex(digest);
  } catch (caught) {
    return Promise.resolve({
      kind: "unavailable",
      reason: `Malformed CID "${cid}": ${caught instanceof Error ? caught.message : String(caught)}`,
    });
  }

  const lookup = opts.preimage ?? preimageManager;
  const timeoutMs = opts.timeoutMs ?? PREIMAGE_LOOKUP_TIMEOUT_MS;

  return new Promise<BulletinPreimageResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: { unsubscribe: () => void } | undefined;

    const finish = (result: BulletinPreimageResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: "unavailable", reason: "aborted" });

    if (opts.signal?.aborted) {
      resolve({ kind: "unavailable", reason: "aborted" });
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => finish({ kind: "unavailable", reason: "preimage lookup timed out" }),
      timeoutMs,
    );

    subscription = lookup.lookup(key, (preimage) => {
      // null = host has no preimage yet; keep waiting until the timeout.
      if (preimage == null) return;
      if (!digestMatches(preimage, digest)) {
        finish({
          kind: "unavailable",
          reason: "host preimage failed the content-address integrity check",
        });
        return;
      }
      finish({ kind: "ok", bytes: preimage });
    });
    // The callback can fire synchronously (test stubs) before assignment.
    if (settled) subscription.unsubscribe();
  });
};

function digestMatches(bytes: Uint8Array, digest: Uint8Array): boolean {
  if (digest.length !== BLAKE2B_256_LENGTH) return false;
  const actual = blake2b(bytes, { dkLen: BLAKE2B_256_LENGTH });
  for (let i = 0; i < BLAKE2B_256_LENGTH; i += 1) {
    if (actual[i] !== digest[i]) return false;
  }
  return true;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i]! < 0x10 ? "0" : "") + bytes[i]!.toString(16);
  }
  return hex as `0x${string}`;
}
