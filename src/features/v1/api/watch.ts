// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * v1 chain watch: backfill from the persisted checkpoint, then tail the
 * finalized head. Read-only — the chain has already settled, so we track
 * finalized (not best) blocks and never worry about reorgs.
 *
 * The PAPI event/Location/account shapes are decoded here (the chain-coupled
 * layer); the pure matching/dedupe/report logic lives in `matching.ts` /
 * `reports.ts` and is unit-tested. `extractCredit` is exported so its
 * decoding assumptions are pinned by tests.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { getSs58AddressInfo } from "@polkadot-api/substrate-bindings";
import type { PolkadotClient } from "polkadot-api";

import { backfillRange } from "@/features/v1/api/backfill.ts";
import { buildPaymentEvent, type NormalizedCredit, type TokenMatcher } from "@/features/v1/api/matching.ts";
import type { PaymentEvent, V1Terminal } from "@/features/v1/types.ts";
import type { V1CatchupProgress } from "@/features/v1/store/useV1Store.ts";


const ACCOUNT_ID32_HEX_RE = /^0x[0-9a-fA-F]{64}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Convert a PAPI-decoded AccountId (SS58 string, hex, Binary, or bytes) to 0x-AccountId32. */
function accountToHex(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (ACCOUNT_ID32_HEX_RE.test(value)) return value.toLowerCase();
    const info = getSs58AddressInfo(value);
    if (info.isValid && info.publicKey.length === 32) return `0x${bytesToHex(info.publicKey)}`;
    return undefined;
  }
  if (value instanceof Uint8Array && value.length === 32) return `0x${bytesToHex(value)}`;
  const record = asRecord(value);
  if (record && typeof record.asHex === "function") {
    const hex = (record.asHex as () => string)();
    return ACCOUNT_ID32_HEX_RE.test(hex) ? hex.toLowerCase() : undefined;
  }
  return undefined;
}

/** Pull (parachain, palletInstance, generalIndex) from a decoded XCM Location. */
function locationParts(assetId: unknown): Pick<NormalizedCredit, "assetParachainId" | "assetPalletInstance" | "assetGeneralIndex"> {
  const location = asRecord(assetId);
  const interior = location ? asRecord(location.interior) : null;
  if (!interior) return {};
  const raw = interior.value;
  const junctions = Array.isArray(raw) ? raw : [raw];
  const parts: Pick<NormalizedCredit, "assetParachainId" | "assetPalletInstance" | "assetGeneralIndex"> = {};
  for (const junction of junctions) {
    const entry = asRecord(junction);
    if (!entry || typeof entry.type !== "string") continue;
    if (entry.type === "Parachain") parts.assetParachainId = Number(entry.value);
    else if (entry.type === "PalletInstance") parts.assetPalletInstance = Number(entry.value);
    else if (entry.type === "GeneralIndex") parts.assetGeneralIndex = BigInt(entry.value as string | number | bigint);
  }
  return parts;
}

/** Pull a bigint from a decoded numeric field, or null when absent/invalid. */
function tryBigInt(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    return null;
  }
}

/** Extrinsic index of a record's block phase, or undefined (Initialization/Finalization). */
function phaseExtrinsicIndex(record: unknown): number | undefined {
  const phase = asRecord(asRecord(record)?.phase);
  return phase?.type === "ApplyExtrinsic" && typeof phase.value === "number" ? phase.value : undefined;
}

function extractAssetsTransferred(event: Record<string, unknown>): NormalizedCredit | null {
  const inner = asRecord(event.value);
  if (!inner || inner.type !== "Transferred") return null;
  const fields = asRecord(inner.value);
  if (!fields) return null;
  const toHex = accountToHex(fields.to);
  if (!toHex) return null;
  const amountPlanck = tryBigInt(fields.amount);
  if (amountPlanck === null) return null;
  return {
    source: "assets-transferred",
    ...locationParts(fields.asset_id),
    toHex,
    fromHex: accountToHex(fields.from),
    amountPlanck,
  };
}

/**
 * `Coinage.RecyclerUnloadedIntoExternalAsset { to, amount }` and the surplus
 * variant `…AndVouchers { to, external_asset_amount, … }`. A merchant offboard
 * surfaces here even when the inner `Assets.Transferred` credits an intermediate
 * rather than the merchant. Matched by recipient only — the event carries no
 * asset id (the unload target IS the configured external asset).
 */
function extractCoinageUnload(event: Record<string, unknown>): NormalizedCredit | null {
  const inner = asRecord(event.value);
  if (!inner) return null;
  if (inner.type === "RecyclerUnloadedIntoExternalAsset") {
    const fields = asRecord(inner.value);
    const toHex = fields ? accountToHex(fields.to) : undefined;
    const amountPlanck = fields ? tryBigInt(fields.amount) : null;
    if (!toHex || amountPlanck === null) return null;
    return { source: "coinage-unloaded", toHex, amountPlanck };
  }
  if (inner.type === "RecyclerUnloadedIntoExternalAssetAndVouchers") {
    const fields = asRecord(inner.value);
    const toHex = fields ? accountToHex(fields.to) : undefined;
    const amountPlanck = fields ? tryBigInt(fields.external_asset_amount) : null;
    if (!toHex || amountPlanck === null) return null;
    return { source: "coinage-unloaded-vouchers", toHex, amountPlanck };
  }
  return null;
}

/**
 * Extract a normalized credit from a raw `System.Events` record, or null.
 * Dispatches on the pallet: `Assets.Transferred` (token-filtered downstream)
 * and `Coinage.RecyclerUnloadedIntoExternalAsset[AndVouchers]` (recipient-only).
 */
export function extractCredit(record: unknown): NormalizedCredit | null {
  const event = asRecord(asRecord(record)?.event);
  if (!event) return null;
  if (event.type === "Assets") return extractAssetsTransferred(event);
  if (event.type === "Coinage") return extractCoinageUnload(event);
  return null;
}

interface SystemEventsShim {
  System: { Events: { getValue(opts?: { at?: string }): Promise<unknown[]> } };
}

/** Read + match all token-credit transfers in one block. */
export async function processBlock(
  client: PolkadotClient,
  blockHash: string,
  blockNumber: number,
  token: TokenMatcher,
  terminalsByPayoutHex: ReadonlyMap<string, V1Terminal>,
  observedAtMs: number,
): Promise<PaymentEvent[]> {
  const query = client.getUnsafeApi().query as unknown as SystemEventsShim;
  const records = await query.System.Events.getValue({ at: blockHash });
  const out: PaymentEvent[] = [];
  for (let eventIndex = 0; eventIndex < records.length; eventIndex++) {
    const rawRecord = records[eventIndex];
    const credit = extractCredit(rawRecord);
    if (!credit) continue;
    const event = buildPaymentEvent(credit, token, terminalsByPayoutHex, {
      blockNumber,
      blockHash,
      eventIndex,
      extrinsicIndex: phaseExtrinsicIndex(rawRecord),
      observedAtMs,
    });
    if (event) out.push(event);
  }
  return out;
}

export interface V1WatchDeps {
  client: PolkadotClient;
  token: TokenMatcher;
  terminalsByPayoutHex: ReadonlyMap<string, V1Terminal>;
  /** Called once per processed block (incl. empty) so the caller can persist + advance the checkpoint. */
  onBlock: (events: PaymentEvent[], blockNumber: number) => Promise<void> | void;
  onWarn?: (message: string) => void;
  onError?: (error: unknown) => void;
  onCatchupProgress?: (progress: V1CatchupProgress | null) => void;
  /**
   * Called at backfill start with a `skip()` that jumps the scan to the target
   * head, and with `null` when catchup ends (so the UI can offer/withdraw the
   * skip action). No-op outside catchup.
   */
  onSkipAvailable?: (skip: (() => void) | null) => void;
  /** Reports the finalized head as it advances — payments at/below it are confirmed. */
  onFinalized?: (blockNumber: number) => void;
  /** Aborting this signal stops the backfill scan immediately (discarded/replaced monitor). */
  signal?: AbortSignal;
  /**
   * Direct WebSocket URL for the People chain. When set, a temporary raw WS
   * PAPI client is created for the backfill phase — the host's chainHead-only
   * provider doesn't support the legacy `chain_getBlockHash` RPC needed for
   * historical scanning, but a plain WS connection does. The temp client is
   * destroyed as soon as catchup finishes; the live tail always uses `client`.
   */
  backfillWsUrl?: string;
  /**
   * Per-block backfill stall bound (ms). If a scan RPC (`chain_getBlockHash` /
   * `System.Events`) doesn't answer within this window, the historical scan is
   * abandoned and the watch jumps to the live tail instead of freezing catchup
   * at 0/N. Defaults to {@link DEFAULT_BACKFILL_STALL_MS}.
   */
  backfillStallMs?: number;
}

export interface V1WatchHandle {
  stop(): void;
}

async function blockHashAt(client: PolkadotClient, blockNumber: number): Promise<string | undefined> {
  const hash = await client._request<string | null, [number]>("chain_getBlockHash", [blockNumber]);
  return hash ?? undefined;
}

/**
 * Best-effort PAPI client teardown. `destroy()` can throw when called before
 * the underlying WebSocket connection is fully established (e.g. skip-to-head
 * fires while the backfill WS client is still connecting).
 */
function safeDestroy(client: PolkadotClient | null): void {
  if (!client) return;
  try {
    client.destroy();
  } catch {
    /* ignore — the OS will clean up the socket when the object is collected */
  }
}
const HEAD_FETCH_TIMEOUT_MS = 20_000;
const FINALIZED_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_BACKFILL_STALL_MS = 20_000;

/** Race a host-bridge read against a timeout so a non-delivering chainHead fails loud, not silent. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Start the watch: backfill `(checkpoint, head]`, then tail the chain head.
 * Prefers FINALIZED (reorg-proof). Falls back to BEST blocks when the host
 * bridge advertises the chain yet never delivers chainHead `finalized` (best
 * still flows) — otherwise a read-only monitor hangs forever. Returns a handle
 * whose `stop()` tears down the subscription.
 */
export async function startV1Watch(deps: V1WatchDeps, checkpoint: number | undefined): Promise<V1WatchHandle> {
  const { client } = deps;
  const noop: V1WatchHandle = { stop: () => {} };
  const aborted = () => deps.signal?.aborted === true;
  const t0 = performance.now();
  const wdbg = (msg: string) => console.log(`[v1:watch] +${Math.round(performance.now() - t0)}ms ${msg}`);
  if (aborted()) return noop;
  wdbg("fetching chain head…");
  let head: { hash: string; number: number };
  let headMode: "finalized" | "best";
  try {
    head = await withTimeout(client.getFinalizedBlock(), FINALIZED_PROBE_TIMEOUT_MS, "People chain finalized-head fetch");
    headMode = "finalized";
  } catch (error) {
    if (aborted()) return noop;
    // Bridge advertises the chain but isn't delivering chainHead `finalized`
    // (best blocks still arrive). Fall back to best-block tracking — read-only,
    // so we accept rare shallow reorg exposure, like t3rminal-v1 on these hosts.
    wdbg(`finalized unavailable (${error instanceof Error ? error.message : String(error)}); using best blocks`);
    deps.onWarn?.("chain finality unavailable via host — tracking best blocks");
    const best = await withTimeout(client.getBestBlocks(), HEAD_FETCH_TIMEOUT_MS, "People chain best-blocks fetch");
    const tip = best[0];
    if (!tip) throw new Error("People chain returned no best block");
    head = tip;
    headMode = "best";
  }
  if (aborted()) return noop;
  wdbg(`head=#${head.number} (${headMode})`);

  const plan = backfillRange(checkpoint, head.number);
  wdbg(plan ? `backfill plan ${plan.from}..${plan.to}${plan.truncated ? " (truncated)" : ""}` : checkpoint === undefined ? "no backfill (first run: adopt head)" : "no backfill (already caught up)");
  if (plan) {
    // For backfill we need chain_getBlockHash (legacy JSON-RPC).  The host's
    // chainHead-only provider doesn't expose it, so spin up a cheap direct-WS
    // client for the scan only.  We import lazily so the hot path (no backfill)
    // doesn't pull in the WS provider module.
    let backfillClient: PolkadotClient | null = null;
    if (deps.backfillWsUrl) {
      const { createClient } = await import("polkadot-api");
      const { getWsProvider } = await import("@polkadot-api/ws-provider");
      const { sandboxSafeWsConfig } = await import("@/shared/api/sandbox-safe-websocket.ts");
      backfillClient = createClient(getWsProvider(deps.backfillWsUrl, sandboxSafeWsConfig()));
      wdbg(`backfill: using direct WS client → ${deps.backfillWsUrl}`);
    }
    const scanClient = backfillClient ?? client;

    const totalBlocks = plan.to - plan.from + 1;
    deps.onCatchupProgress?.({
      fromBlock: plan.from,
      currentBlock: plan.from - 1,
      targetBlock: plan.to,
      processedBlocks: 0,
      totalBlocks,
      truncated: plan.truncated,
    });
    if (plan.truncated) {
      deps.onWarn?.(`backfill gap exceeds cap; scanning ${plan.from}..${plan.to} (older blocks skipped)`);
    }
    const stallMs = deps.backfillStallMs ?? DEFAULT_BACKFILL_STALL_MS;
    // Resolve the instant a skip is requested OR the monitor is torn down, so an
    // in-flight block fetch never delays the jump / pins a dead loop alive.
    let skipRequested = false;
    let signalSkip = (): void => {};
    const interrupted = new Promise<"interrupt">((resolve) => {
      signalSkip = () => {
        skipRequested = true;
        resolve("interrupt");
      };
      // Abort (replaced/unmounted monitor) interrupts the scan too. Without this
      // the loop's signal can't unblock an already-issued fetch, so a stalled
      // RPC would keep the dead loop — and its WS client — alive after teardown.
      if (deps.signal) {
        if (deps.signal.aborted) resolve("interrupt");
        else deps.signal.addEventListener("abort", () => resolve("interrupt"), { once: true });
      }
    });
    deps.onSkipAvailable?.(signalSkip);
    const race = <T,>(work: Promise<T>): Promise<T | "interrupt"> =>
      aborted() ? Promise.resolve("interrupt") : Promise.race([work, interrupted]);

    // The host's chainHead-only bridge can't serve `chain_getBlockHash`, so the
    // scan runs against a direct-WS client. If that endpoint is unreachable from
    // the sandboxed WebView (or down), an unbounded fetch would hang forever and
    // freeze catchup at 0/N. Bound every block fetch: on a stall, abandon the
    // historical scan and fall through to the live tail.
    const scanBlock = async (blockNumber: number): Promise<PaymentEvent[] | "interrupt"> => {
      const hash = await race(withTimeout(blockHashAt(scanClient, blockNumber), stallMs, `backfill block #${blockNumber} hash`));
      if (hash === "interrupt") return "interrupt";
      if (!hash) return [];
      return race(withTimeout(processBlock(scanClient, hash, blockNumber, deps.token, deps.terminalsByPayoutHex, Date.now()), stallMs, `backfill block #${blockNumber} events`));
    };

    let backfillStalled = false;
    let lastProcessed = plan.from - 1;
    for (let blockNumber = plan.from; blockNumber <= plan.to; blockNumber++) {
      if (skipRequested || aborted()) break;
      let result: PaymentEvent[] | "interrupt";
      try {
        result = await scanBlock(blockNumber);
      } catch (error) {
        backfillStalled = true;
        const reason = error instanceof Error ? error.message : String(error);
        deps.onWarn?.(`backfill scan stalled at #${blockNumber} (${reason}); skipping to head #${plan.to} — payments in ${blockNumber}..${plan.to} were not recorded`);
        wdbg(`backfill stalled at #${blockNumber}: ${reason}`);
        break;
      }
      if (result === "interrupt" || aborted()) break;
      await deps.onBlock(result, blockNumber);
      lastProcessed = blockNumber;
      deps.onCatchupProgress?.({
        fromBlock: plan.from,
        currentBlock: blockNumber,
        targetBlock: plan.to,
        processedBlocks: blockNumber - plan.from + 1,
        totalBlocks,
        truncated: plan.truncated,
      });
    }
    // Aborted (replaced monitor): leave all state to the replacement, write nothing.
    if (aborted()) { safeDestroy(backfillClient); return noop; }
    if ((skipRequested || backfillStalled) && lastProcessed < plan.to) {
      // Jump the checkpoint straight to the catchup target head. Blocks in
      // (lastProcessed, plan.to] are NOT scanned — their payments won't be
      // recorded. Triggered by an operator skip or a stalled scan RPC (warned
      // above); persisting the head checkpoint stops a restart re-stalling here.
      await deps.onBlock([], plan.to);
      if (skipRequested) {
        deps.onWarn?.(`skipped ${plan.to - lastProcessed} block(s) to head #${plan.to}; payments in that range were not recorded`);
      }
      wdbg(`${skipRequested ? "skip" : "stall"}-to-head: jumped ${lastProcessed + 1}..${plan.to}`);
    }
    deps.onCatchupProgress?.(null);
    safeDestroy(backfillClient);
    backfillClient = null;
    wdbg("backfill complete");
  } else if (checkpoint === undefined) {
    // First run: adopt the head as the checkpoint without deep-scanning history.
    await deps.onBlock([], head.number);
  }
  if (aborted()) return noop;
  wdbg(`subscribing to live tail (scan=best+finalized)`);

  // Advance the processed cursor up to a new head — gap-safe and serialized, so
  // overlapping/batched emissions never double-run or skip a block. Hashes come
  // straight from the chainHead stream (pinned), so the tail needs no legacy
  // block-hash RPC and works wherever the bridge delivers blocks.
  let tailFrom = head.number;
  let pump: Promise<void> = Promise.resolve();
  const advance = (blocks: ReadonlyArray<{ hash: string; number: number }>): void => {
    pump = pump
      .then(async () => {
        const fresh = blocks.filter((b) => b.number > tailFrom).sort((a, b) => a.number - b.number);
        for (const block of fresh) {
          if (aborted()) return;
          const events = await processBlock(client, block.hash, block.number, deps.token, deps.terminalsByPayoutHex, Date.now());
          await deps.onBlock(events, block.number);
          tailFrom = block.number;
        }
      })
      .catch((error) => deps.onError?.(error));
  };

  // BEST blocks → early detection (payment shows the moment it lands, before
  // finality), driving the detected → finalizing lifecycle. Best-effort.
  let bestSub: { unsubscribe: () => void } | undefined;
  try {
    bestSub = client.bestBlocks$.subscribe({
      next: (blocks) => advance(blocks),
      error: (error) => deps.onError?.(error),
    });
  } catch {
    /* best stream unavailable on this provider */
  }

  // FINALIZED blocks → mark confirmed AND act as the reliable scan path: a block
  // not yet seen via best is still scanned here, so payments always surface even
  // if the host's best-block stream is flaky. `advance` de-dupes via `tailFrom`.
  let finalizedSub: { unsubscribe: () => void } | undefined;
  try {
    finalizedSub = client.finalizedBlock$.subscribe({
      next: (block) => {
        deps.onFinalized?.(block.number);
        advance([block]);
      },
      error: () => {},
    });
  } catch {
    /* finalized stream unavailable on this provider */
  }

  return {
    stop: () => {
      bestSub?.unsubscribe();
      finalizedSub?.unsubscribe();
    },
  };
}
