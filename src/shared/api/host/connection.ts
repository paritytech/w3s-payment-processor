// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Host detection + transport handshake + remote-origin permission. Trimmed
 * from `apps/w3spay/src/shared/api/host/connection.ts` to what a read-only
 * payment monitor needs: no camera, no QR, no Spektr/iOS gates.
 */
import { requestPermission, sandboxProvider, sandboxTransport } from "@/shared/api/host/host-api.ts";
import { isDev } from "@/config.ts";

declare global {
  interface Window {
    /** Set by Polkadot Desktop's webview shell. */
    __HOST_WEBVIEW_MARK__?: boolean;
  }
}

export type HostEnvironment = "desktop-webview" | "web-iframe" | "standalone";

/** Synchronous DOM-based host detection — safe to call at first render. */
export function detectHostEnvironment(): HostEnvironment {
  if (typeof window === "undefined") return "standalone";
  if (window.__HOST_WEBVIEW_MARK__ === true) return "desktop-webview";
  try {
    if (window !== window.top) return "web-iframe";
  } catch {
    // Cross-origin iframe — `window.top` access throws; treat as hosted.
    return "web-iframe";
  }
  return "standalone";
}

export function isInHost(): boolean {
  return detectHostEnvironment() !== "standalone";
}

/** Whether the in-page sandbox MessagePort published by the host is present. */
export function isSandboxReady(): boolean {
  return sandboxProvider.isCorrectEnvironment();
}

/** True only during `vite dev` in a plain standalone tab (no host bridge). */
export function isDevStandalone(): boolean {
  if (!isDev) return false;
  if (typeof window === "undefined") return false;
  return !isInHost();
}

const HOST_HANDSHAKE_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

let connected = false;
let inFlightHandshake: Promise<boolean> | null = null;

/**
 * Await the host-API transport handshake. MUST be awaited before any direct
 * host request — on slow webview-port bring-up the SDK otherwise surfaces
 * `RequestCredentialsErr::Unknown ("Polkadot host is not ready")`. Returns
 * `false` outside a host or on timeout/failure (not cached, so a retry gets a
 * fresh shot); a successful `true` sticks for the page lifetime.
 */
export async function connectToHost(timeoutMs: number = HOST_HANDSHAKE_TIMEOUT_MS): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!isInHost()) return false;
  if (connected) return true;
  if (inFlightHandshake) return inFlightHandshake;

  inFlightHandshake = withTimeout(
    sandboxTransport.isReady().then((ready) => {
      connected = ready;
      return ready;
    }),
    timeoutMs,
    "[host] handshake",
  )
    .catch((caught) => {
      console.warn(`[host] handshake failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      connected = false;
      return false;
    })
    .finally(() => {
      inFlightHandshake = null;
    });

  return inFlightHandshake;
}
export function isHostConnected(): boolean {
  return connected;
}


const HOST_MODAL_MAX_LOCK_MS = 120_000;

let hostModalQueue: Promise<unknown> = Promise.resolve();

export function runExclusiveHostModal<T>(task: () => PromiseLike<T>): Promise<T> {
  const run = Promise.resolve(hostModalQueue).then(task, task);
  const { promise: ceiling, resolve: openCeiling } = Promise.withResolvers<void>();
  const timer = setTimeout(openCeiling, HOST_MODAL_MAX_LOCK_MS);
  hostModalQueue = Promise.race([
    run.then(
      () => undefined,
      () => undefined,
    ),
    ceiling,
  ]).finally(() => {
    clearTimeout(timer);
  });
  return run;
}

export interface RemoteOriginPermissionOutcome {
  granted: boolean;
  error?: string;
}

const remoteOriginCache = new Map<string, RemoteOriginPermissionOutcome>();
const inFlightRemoteOrigins = new Map<string, Promise<RemoteOriginPermissionOutcome>>();

/**
 * No-op outside a host (the browser connects directly). Grants are cached per
 * origin-set after the first success, and concurrent calls for the same
 * origin-set share a single in-flight promise so the boot-time call and the
 * v1 engine's later call don't double-prompt the host.
 */
export async function requestRemoteOriginPermission(
  origins: readonly string[],
): Promise<RemoteOriginPermissionOutcome> {
  if (!isInHost() || origins.length === 0) return { granted: true };
  const key = [...origins].sort().join("|");
  const cached = remoteOriginCache.get(key);
  if (cached) return cached;
  const inFlight = inFlightRemoteOrigins.get(key);
  if (inFlight) return inFlight;

  const pending = (async (): Promise<RemoteOriginPermissionOutcome> => {
    const ready = await connectToHost();
    if (!ready) return { granted: false, error: "host transport not ready" };


    return runExclusiveHostModal(() =>
      withTimeout(
        requestPermission({ tag: "Remote", value: [...origins] }).match<RemoteOriginPermissionOutcome>(
          (granted) => ({ granted }),
          (err) => ({ granted: false, error: err.payload?.reason ?? err.message }),
        ),
        HOST_HANDSHAKE_TIMEOUT_MS,
        "[host] remote-origin permission",
      ).catch((caught) => {
        console.warn(`[host] remote-origin permission failed: ${caught instanceof Error ? caught.message : String(caught)}`);
        return { granted: false, error: "remote-origin permission timed out" } as RemoteOriginPermissionOutcome;
      }),
    );
  })()
    .then((outcome) => {
      if (outcome.granted) remoteOriginCache.set(key, outcome);
      return outcome;
    })
    .finally(() => {
      inFlightRemoteOrigins.delete(key);
    });

  inFlightRemoteOrigins.set(key, pending);
  return pending;
}

/**
 * Non-origin Remote grants — the host surfaces the processor's publish path
 * touches: `ChainSubmit` (the `addProcessorReport` registry write) and
 * `PreimageSubmit` (the Bulletin ciphertext upload).
 */
export type RemotePermissionKind = "ChainSubmit" | "PreimageSubmit" | "StatementSubmit";

export interface RemotePermissionOutcome {
  granted: boolean;
  error?: string;
}

const remotePermissionCache = new Map<RemotePermissionKind, RemotePermissionOutcome>();
const inFlightRemotePermissions = new Map<RemotePermissionKind, Promise<RemotePermissionOutcome>>();

export async function requestRemotePermission(
  kind: RemotePermissionKind,
): Promise<RemotePermissionOutcome> {
  if (!isInHost()) return { granted: true };
  const cached = remotePermissionCache.get(kind);
  if (cached) return cached;
  const inFlight = inFlightRemotePermissions.get(kind);
  if (inFlight) return inFlight;

  const pending = (async (): Promise<RemotePermissionOutcome> => {
    const ready = await connectToHost();
    if (!ready) return { granted: false, error: "host transport not ready" };
    return runExclusiveHostModal(() =>
      requestPermission({ tag: kind, value: undefined }).match<RemotePermissionOutcome>(
        (granted) => ({ granted }),
        (err) => ({ granted: false, error: err.payload?.reason ?? err.message }),
      ),
    );
  })()
    .then((outcome) => {
      if (outcome.granted) remotePermissionCache.set(kind, outcome);
      return outcome;
    })
    .finally(() => {
      inFlightRemotePermissions.delete(kind);
    });

  inFlightRemotePermissions.set(kind, pending);
  return pending;
}
