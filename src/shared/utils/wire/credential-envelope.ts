// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * The credential-envelope format for the remote merchant credential bundle.
 *
 * AES-256-GCM with a key derived from the merchant passkey via PBKDF2-SHA256.
 * THIS module owns the one documented envelope format; the browser unlock path
 * (`@/shared/api/remote-credentials`) and the on-chain report publisher
 * (`@/features/reports/api/report-storage`) encrypt/decrypt through it, and the
 * w3spay-admin app vendors a byte-compatible copy — so the formats never drift.
 *
 * Wire shape — a UTF-8 JSON object (content-addressed on Bulletin, or served
 * over HTTPS):
 *
 *   { format, version, kdf, iterations, cipher, salt, iv, ciphertext }
 *
 * `salt` / `iv` / `ciphertext` are standard base64. The plaintext under
 * `ciphertext` is the UTF-8 JSON credential bundle (`{ groupId, profile, v1,
 * v2 }`). The envelope header `format:version` is bound as AES-GCM additional
 * authenticated data, so editing it invalidates the tag.
 *
 * Isomorphic: uses WebCrypto (`crypto.subtle`) and the global `atob`/`btoa`,
 * both available in browsers and Node ≥ 20 (and the vitest "node" env).
 *
 * Fail-closed: a wrong passkey or any tampering (header, salt, iv, ciphertext)
 * fails GCM authentication and throws — it NEVER returns partial plaintext.
 */

export const ENVELOPE_FORMAT = "w3s-credential-envelope";
export const ENVELOPE_VERSION = 1;

/** OWASP-2023 PBKDF2-HMAC-SHA256 floor; baked into each envelope so it stays tunable. */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

/** Hard minimum accepted on decrypt — rejects envelopes weakened below this. */
const MIN_PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export class CredentialEnvelopeError extends Error {
  override readonly name = "CredentialEnvelopeError";
}

export interface CredentialEnvelope {
  format: "w3s-credential-envelope";
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  cipher: "AES-256-GCM";
  /** base64 PBKDF2 salt. */
  salt: string;
  /** base64 AES-GCM IV (96-bit). */
  iv: string;
  /** base64 AES-GCM `ciphertext ‖ tag`. */
  ciphertext: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(value: string, field: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new CredentialEnvelopeError(`envelope.${field} is not valid base64`);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** AES-GCM additional authenticated data — binds the ciphertext to the header. */
function aad(version: number): Uint8Array {
  return new TextEncoder().encode(`${ENVELOPE_FORMAT}:v${version}`);
}

async function deriveUnlockKey(
  passkey: string,
  salt: Uint8Array,
  iterations: number,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passkey),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

/**
 * Encrypt a plaintext bundle into a fresh envelope. Random per-call salt + IV;
 * the iteration count is recorded in the envelope so future tuning stays
 * backward-compatible with already-stored bundles.
 */
export async function encryptCredentialEnvelope(
  plaintext: Uint8Array,
  passkey: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<CredentialEnvelope> {
  if (passkey === "") throw new CredentialEnvelopeError("passkey must not be empty");
  if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS) {
    throw new CredentialEnvelopeError(`iterations must be an integer ≥ ${MIN_PBKDF2_ITERATIONS}`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveUnlockKey(passkey, salt, iterations, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(ENVELOPE_VERSION) as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    kdf: "PBKDF2-SHA256",
    iterations,
    cipher: "AES-256-GCM",
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

/**
 * Structurally validate an untrusted value as a `CredentialEnvelope`. Rejects
 * unknown format/version/kdf/cipher, weak iteration counts, and malformed
 * base64 / IV length BEFORE any key derivation. Throws `CredentialEnvelopeError`.
 */
export function parseCredentialEnvelope(raw: unknown): CredentialEnvelope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CredentialEnvelopeError("envelope must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (r.format !== ENVELOPE_FORMAT) {
    throw new CredentialEnvelopeError(`unexpected envelope format ${JSON.stringify(r.format)}`);
  }
  if (r.version !== ENVELOPE_VERSION) {
    throw new CredentialEnvelopeError(`unsupported envelope version ${JSON.stringify(r.version)}`);
  }
  if (r.kdf !== "PBKDF2-SHA256") {
    throw new CredentialEnvelopeError(`unsupported kdf ${JSON.stringify(r.kdf)}`);
  }
  if (r.cipher !== "AES-256-GCM") {
    throw new CredentialEnvelopeError(`unsupported cipher ${JSON.stringify(r.cipher)}`);
  }
  if (typeof r.iterations !== "number" || !Number.isInteger(r.iterations) || r.iterations < MIN_PBKDF2_ITERATIONS) {
    throw new CredentialEnvelopeError(`envelope.iterations must be an integer ≥ ${MIN_PBKDF2_ITERATIONS}`);
  }
  for (const field of ["salt", "iv", "ciphertext"] as const) {
    if (typeof r[field] !== "string" || r[field] === "") {
      throw new CredentialEnvelopeError(`envelope.${field} must be a non-empty base64 string`);
    }
  }
  const salt = base64ToBytes(r.salt as string, "salt");
  const iv = base64ToBytes(r.iv as string, "iv");
  if (salt.length < 8) throw new CredentialEnvelopeError("envelope.salt is too short");
  if (iv.length !== IV_BYTES) throw new CredentialEnvelopeError(`envelope.iv must decode to ${IV_BYTES} bytes`);
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    kdf: "PBKDF2-SHA256",
    iterations: r.iterations,
    cipher: "AES-256-GCM",
    salt: r.salt as string,
    iv: r.iv as string,
    ciphertext: r.ciphertext as string,
  };
}

/**
 * Decrypt an untrusted envelope with the merchant passkey, returning the
 * plaintext bundle bytes. Throws `CredentialEnvelopeError` on a malformed
 * envelope, a wrong passkey, or any tampering (GCM tag mismatch).
 */
export async function decryptCredentialEnvelope(
  rawEnvelope: unknown,
  passkey: string,
): Promise<Uint8Array> {
  if (passkey === "") throw new CredentialEnvelopeError("passkey must not be empty");
  const envelope = parseCredentialEnvelope(rawEnvelope);
  const salt = base64ToBytes(envelope.salt, "salt");
  const iv = base64ToBytes(envelope.iv, "iv");
  const ciphertext = base64ToBytes(envelope.ciphertext, "ciphertext");
  const key = await deriveUnlockKey(passkey, salt, envelope.iterations, ["decrypt"]);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(envelope.version) as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new CredentialEnvelopeError("decryption failed — wrong passkey or tampered envelope");
  }
}
