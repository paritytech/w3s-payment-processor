// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * v2 durable records over the host KV: `v2-records:index` (id[]) +
 * `v2-records:item:<id>`. Idempotent across restarts — the index is rehydrated
 * into the dedupe set on boot, and re-delivered payments upsert in place.
 */
import type { KvStore } from "@/shared/utils/kv-store.ts";
import type { PaymentRecord } from "@/features/v2/types.ts";

const RECORDS_INDEX_KEY = "v2-records:index";

/** Load all records into an id→record map (the orchestrator's working set). */
export async function loadRecords(kv: KvStore): Promise<Map<string, PaymentRecord>> {
  const ids = (await kv.getJSON<string[]>(RECORDS_INDEX_KEY)) ?? [];
  const entries = await Promise.all(
    ids.map(async (id) => {
      const record = await kv.getJSON<PaymentRecord>(`v2-records:item:${id}`);
      return record ? ([id, record] as const) : null;
    }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, PaymentRecord] => entry != null));
}

/**
 * Insert or update a record. New ids are appended to the index; existing ids
 * (a re-claim after a blocked attempt) only rewrite the item.
 */
export async function upsertRecord(kv: KvStore, record: PaymentRecord): Promise<void> {
  const ids = (await kv.getJSON<string[]>(RECORDS_INDEX_KEY)) ?? [];
  await kv.setJSON(`v2-records:item:${record.id}`, record);
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await kv.setJSON(RECORDS_INDEX_KEY, ids);
  }
}
