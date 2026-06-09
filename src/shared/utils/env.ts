// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

export function readString(key: string, fallback: string): string {
  const value = import.meta.env[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}
/**
 * Like `readString` but throws at module load if the env var is missing or
 * empty. Use for env vars that have no defensible local default — e.g.
 * the DotNS product domain, which is the on-chain identity of the deployed
 * SPA AND the host product account the v2 claim engine resolves; falling
 * back to a hardcoded value would silently mis-credit claims or publish
 * to the wrong chain identity.
 */
export function readStringRequired(key: string): string {
  const value = import.meta.env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Missing required env var ${key}. Copy .env.example to .env and set it.`,
    );
  }
  return value;
}

export function readInt(key: string, fallback: number): number {
  const value = import.meta.env[key];
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readBigInt(key: string, fallback: bigint): bigint {
  const value = import.meta.env[key];
  if (typeof value !== "string" || value.trim() === "") return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

export function readBool(key: string, fallback: boolean): boolean {
  const value = import.meta.env[key];
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}