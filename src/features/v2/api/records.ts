// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * v2 durable records over the host KV: `v2-records:index` (storage keys) +
 * `v2-records:item:<key>`, where the key is `v2PaymentKey` — `(topic, id,
 * payload timestamp)`. The payload `id` alone is payer-chosen and can collide
 * across tills, so it never keys storage on its own. Idempotent across
 * restarts: the index rehydrates the dedupe set on boot, and re-delivered
 * payments upsert in place.
 */
import type { KvStore } from "@/shared/utils/kv-store.ts";
import { v2PaymentKey, type PaymentRecord } from "@/features/v2/types.ts";

const RECORDS_INDEX_KEY = "v2-records:index";

/** Load all records into a key→record map (the orchestrator's working set). */
export async function loadRecords(kv: KvStore): Promise<Map<string, PaymentRecord>> {
  const storageKeys = (await kv.getJSON<string[]>(RECORDS_INDEX_KEY)) ?? [];
  const entries = await Promise.all(
    storageKeys.map(async (storageKey) => {
      const record = await kv.getJSON<PaymentRecord>(`v2-records:item:${storageKey}`);
      return record
        ? ([v2PaymentKey(record.topicHex, record.id, record.timestampMs), record] as const)
        : null;
    }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, PaymentRecord] => entry != null));
}

/**
 * Insert or update a record, keyed by `v2PaymentKey`. A new key is appended to
 * the index; an existing one (a re-claim after a blocked/failed attempt) only
 * rewrites the item.
 */
export async function upsertRecord(kv: KvStore, record: PaymentRecord): Promise<void> {
  const key = v2PaymentKey(record.topicHex, record.id, record.timestampMs);
  const keys = (await kv.getJSON<string[]>(RECORDS_INDEX_KEY)) ?? [];
  await kv.setJSON(`v2-records:item:${key}`, record);
  if (!keys.includes(key)) {
    keys.push(key);
    await kv.setJSON(RECORDS_INDEX_KEY, keys);
  }
}
