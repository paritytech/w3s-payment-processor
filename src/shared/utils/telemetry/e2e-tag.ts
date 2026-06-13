// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech
declare global { interface Window { __W3SPAY_E2E_TAG?: string } }
export function getE2eTag(): string | undefined { if (typeof window === "undefined") return undefined; const t = window.__W3SPAY_E2E_TAG; return typeof t === "string" && t.length > 0 ? t : undefined; }
