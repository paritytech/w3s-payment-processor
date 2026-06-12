// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Host statement-store subscription. The v2 orchestrator subscribes to all
 * enabled terminal topics in one `matchAny` subscription and routes each
 * statement by its matched topic. This is the only v2 statement source —
 * standalone (no host) has no live feed (decode-only), per the spec.
 *
 * The seam itself logs every subscription lifecycle event (subscribe / each
 * delivered page / unsubscribe / host interrupt) under the `[v2:stmt]` prefix
 * so the DebugPanel's Console tab shows the raw host activity independent of
 * the engine — useful when the question is "is the subscription even alive?".
 */
import {
  createStatementStore,
  sandboxTransport,
  type StatementsPage,
  type Subscription,
} from "@/shared/api/host/host-api.ts";
import { topicKey } from "@/shared/utils/wire/topic.ts";
import { unwrapVecPrefixIfPresent } from "@/shared/utils/wire/scale.ts";
import { breadcrumb, captureError } from "@/shared/utils/telemetry/index.ts";

/**
 * Subscribe to a set of statement-store topics. The callback fires with each
 * delivered `StatementsPage`; the returned `Subscription` must be released on
 * teardown. Production seam — tests inject a fake of this signature.
 */
export type SubscribeStatementTopics = (
  topics: Uint8Array[],
  onPage: (page: StatementsPage) => void,
) => Subscription<void>;

const shortTopic = (t: Uint8Array): string => `${topicKey(t).slice(0, 8)}…`;

export const subscribeStatementTopics: SubscribeStatementTopics = (topics, onPage) => {
  const store = createStatementStore(sandboxTransport);
  const labels = topics.length === 0 ? "<none>" : topics.map(shortTopic).join(", ");
  console.log(`[v2:stmt] subscribing to ${topics.length} topic(s): ${labels}`);

  let pageCount = 0;
  let statementCount = 0;
  const sub = store.subscribe({ matchAny: topics }, (page) => {
    pageCount += 1;
    statementCount += page.statements.length;
    // The chain wraps every v2 ECIES envelope in an outer `Vec<u8>` (the
    // statement's `data: Vec<u8>` field); peel it here so the orchestrator
    // sees a bare `W3sEncryptedPayloadV1`. Bare envelopes pass through
    // untouched because the unwrap only fires on an exact compact-length
    // match.
    const statements = page.statements.map((s) =>
      s.data ? { ...s, data: unwrapVecPrefixIfPresent(s.data) } : s,
    );
    console.log(
      `[v2:stmt] page #${pageCount}: ${page.statements.length} statement(s) ` +
        `(cumulative ${statementCount})`,
    );
    onPage({ ...page, statements });
  });
  sub.onInterrupt(() => {
    console.warn("[v2:stmt] subscription interrupted by host");
    breadcrumb("statement subscription interrupted", undefined, "app", "warning");
    captureError(new Error("host interrupted statement subscription"), { component: "statement-store" });
  });
  return {
    ...sub,
    unsubscribe: () => {
      console.log(
        `[v2:stmt] unsubscribing — saw ${pageCount} page(s), ${statementCount} statement(s)`,
      );
      sub.unsubscribe();
    },
  };
};
