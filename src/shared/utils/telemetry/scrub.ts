// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech
import type { ErrorEvent, TransactionEvent } from "@sentry/core";
const REDACTED = "[redacted]";
const SENSITIVE_KEY_RE = /key|secret|cred|envelope|cheque|mnemonic|privatekey|seed|passphrase/i;
const ADDRESS_KEY_RE = /address/i;
const secrets = new Set<string>();
export function registerSecret(v: string | undefined | null): void { if (typeof v === "string" && v.length >= 8) secrets.add(v); }
export function _clearSecretsForTest(): void { secrets.clear(); }
export function truncateAddress(a: string | undefined | null): string | undefined { if (!a) return a ?? undefined; return a.length > 8 ? `${a.slice(0, 8)}…` : a; }
function scrubText(s: string): string { let o = s; for (const sec of secrets) if (o.includes(sec)) o = o.split(sec).join(REDACTED); return o; }
function scrubDataMap(d: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(d)) {
    if (SENSITIVE_KEY_RE.test(k)) d[k] = REDACTED;
    else if (typeof v === "string") d[k] = ADDRESS_KEY_RE.test(k) ? (truncateAddress(v) ?? v) : scrubText(v);
  }
}
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  try {
    if (typeof event.message === "string") event.message = scrubText(event.message);
    for (const ex of event.exception?.values ?? []) if (typeof ex.value === "string") ex.value = scrubText(ex.value);
    for (const bc of event.breadcrumbs ?? []) { if (typeof bc.message === "string") bc.message = scrubText(bc.message); if (bc.data) scrubDataMap(bc.data as Record<string, unknown>); }
    const td = (event.contexts?.trace?.data ?? null) as Record<string, unknown> | null; if (td) scrubDataMap(td);
    if (event.extra) scrubDataMap(event.extra as Record<string, unknown>);
  } catch { /* telemetry must never throw */ }
  return event;
}
export function scrubTransaction(event: TransactionEvent): TransactionEvent {
  try {
    for (const sp of event.spans ?? []) if (sp.data) scrubDataMap(sp.data as Record<string, unknown>);
    const td = (event.contexts?.trace?.data ?? null) as Record<string, unknown> | null; if (td) scrubDataMap(td);
  } catch { /* telemetry must never throw */ }
  return event;
}
