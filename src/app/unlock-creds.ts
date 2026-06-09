// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * The merchant's unlock credentials (`{ groupId, passkey }`), persisted in
 * localStorage. The unlock gate prefills from here; the on-chain Z-report
 * publisher reuses the SAME passkey to AES-encrypt reports (the literal "same
 * password" the config bundle uses), so reports decrypt with the unlock key.
 *
 * Same trust boundary as any locally-stored secret on the merchant device.
 */
export const CREDS_STORAGE_KEY = "w3spay-unlock-creds:v1";

export interface SavedCreds {
  groupId: string;
  passkey: string;
}

export function loadSavedCreds(): SavedCreds {
  try {
    const raw = localStorage.getItem(CREDS_STORAGE_KEY);
    if (!raw) return { groupId: "", passkey: "" };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { groupId: "", passkey: "" };
    }
    const r = parsed as Record<string, unknown>;
    return {
      groupId: typeof r.groupId === "string" ? r.groupId : "",
      passkey: typeof r.passkey === "string" ? r.passkey : "",
    };
  } catch {
    return { groupId: "", passkey: "" };
  }
}

export function saveCreds(groupId: string, passkey: string): void {
  try {
    localStorage.setItem(CREDS_STORAGE_KEY, JSON.stringify({ groupId, passkey }));
  } catch {
    /* ignore storage failures (private mode / sandbox) */
  }
}
