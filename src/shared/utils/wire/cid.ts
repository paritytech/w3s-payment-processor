// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Bulletin Chain identifies stored payloads by raw-codec CIDv1 with a
 * Blake2b-256 multihash (`dkLen: 32`). The bytes the chain hashes are exactly
 * the bytes passed to `TransactionStorage.store`, so callers MUST hash the same
 * buffer they upload.
 *
 * VENDORED verbatim from `apps/w3spay-admin/src/features/items/contracts/cid.ts`.
 * The two MUST stay byte-identical: the admin CIDs config envelopes, the
 * processor CIDs report envelopes, and the processor's read-back guard compares
 * the on-chain CID against this computation — any drift breaks both.
 */

import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import type { MultihashDigest } from "multiformats/hashes/interface";

/** Blake2b-256 multicodec code (CID spec). */
export const BLAKE2B_256_CODE = 0xb220;

/** Length in bytes of the Blake2b-256 digest. */
export const BLAKE2B_256_LENGTH = 32;

/**
 * Compute the CID Bulletin Chain will index `data` under, as a string.
 * Deterministic in `data`.
 */
export function calculateBulletinCid(data: Uint8Array): string {
  return calculateBulletinCidObject(data).toString();
}

/**
 * Lower-level: return the raw `CID` instance. Diagnostic / digest-comparison
 * code uses this to inspect the multihash bytes; production code should prefer
 * `calculateBulletinCid` which returns the string form the chain stores.
 */
export function calculateBulletinCidObject(data: Uint8Array): CID {
  const hash = blake2b(data, { dkLen: BLAKE2B_256_LENGTH });
  const digest = encodeBlake2bMultihash(hash);
  return CID.createV1(raw.code, digest);
}

function encodeBlake2bMultihash(hash: Uint8Array): MultihashDigest {
  const codeBytes = encodeVarint(BLAKE2B_256_CODE);
  const lengthBytes = encodeVarint(hash.length);
  const bytes = new Uint8Array(codeBytes.length + lengthBytes.length + hash.length);
  bytes.set(codeBytes, 0);
  bytes.set(lengthBytes, codeBytes.length);
  bytes.set(hash, codeBytes.length + lengthBytes.length);
  return {
    code: BLAKE2B_256_CODE,
    size: hash.length,
    bytes,
    digest: hash,
  };
}

function encodeVarint(value: number): Uint8Array {
  const out: number[] = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n & 0x7f);
  return new Uint8Array(out);
}
