// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";

import { DisplayIf } from "@/shared/components/DisplayIf.tsx";
import { Btn } from "@/shared/components/controls.tsx";
import { Icon } from "@/shared/components/Icon.tsx";
import { tone } from "@/shared/utils/tone.ts";
import { resolveRemoteProcessorConfig, RemoteCredentialsError } from "@/shared/api/remote-credentials.ts";
import type { ResolvedProcessorConfig } from "@/config.ts";
import { loadSavedCreds, saveCreds } from "@/app/unlock-creds.ts";

/**
 * Merchant credential unlock — the gate the SPA renders BEFORE any provider or
 * monitor mounts. The merchant enters `{ groupId, passkey }`; on success the
 * decrypted, validated `ResolvedProcessorConfig` is handed up and the app
 * proceeds to Polkadot-host sign-in. On failure the processor stays locked and
 * shows a calm message with optional technical detail behind an expander.
 *
 */
type UnlockStatus = "idle" | "unlocking" | "error";


async function saveBrowserCredential(groupId: string, passkey: string): Promise<void> {
  if (typeof window === "undefined" || !("PasswordCredential" in window)) return;
  try {
    // PasswordCredential constructor is not in every TS DOM lib version; cast defensively.
    const Cred = (window as unknown as { PasswordCredential: new (init: { id: string; password: string; name?: string }) => Credential }).PasswordCredential;
    await navigator.credentials.store(new Cred({ id: groupId, password: passkey, name: groupId }));
  } catch {
    /* non-fatal — password manager unavailable or user declined */
  }
}

async function loadBrowserCredential(): Promise<{ id: string; password: string } | null> {
  if (typeof window === "undefined" || !("PasswordCredential" in window)) return null;
  try {
    const cred = await navigator.credentials.get({
      password: true,
      mediation: "optional",
    } as CredentialRequestOptions);
    if (!cred) return null;
    const pc = cred as unknown as { id: string; password?: string; type: string };
    if (pc.type !== "password" || !pc.password) return null;
    return { id: pc.id, password: pc.password };
  } catch {
    return null;
  }
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "var(--font-sans)",
  color: "var(--text-1)",
  background: "var(--surface-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  outline: "none",
};

const labelStyle: CSSProperties = {
  display: "block",
  textAlign: "left",
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--text-3)",
  marginBottom: 6,
};

export function MerchantUnlockGate({
  onUnlock,
}: {
  onUnlock: (config: ResolvedProcessorConfig) => void;
}) {
  const [groupId, setGroupId] = useState(() => loadSavedCreds().groupId);
  const [passkey, setPasskey] = useState(() => loadSavedCreds().passkey);
  const [showPasskey, setShowPasskey] = useState(false);
  const [status, setStatus] = useState<UnlockStatus>("idle");
  const [message, setMessage] = useState<string | undefined>();
  const [detail, setDetail] = useState<string | undefined>();
  const [showDetail, setShowDetail] = useState(false);

  // Silently upgrade with the browser's password manager if available — it may
  // have a fresher passkey than localStorage (e.g. after a re-provisioning).
  useEffect(() => {
    void loadBrowserCredential().then((cred) => {
      if (!cred) return;
      setGroupId(cred.id);
      setPasskey(cred.password);
    });
  }, []);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (status === "unlocking") return;
      setStatus("unlocking");
      setMessage(undefined);
      setDetail(undefined);
      setShowDetail(false);
      const currentGroupId = groupId.trim();
      console.log(`[unlock] ▶ Unlock pressed  group="${currentGroupId}"  passkey=${passkey.length} chars`);
      try {
        const config = await resolveRemoteProcessorConfig(currentGroupId, passkey);
        // Persist before clearing state so we still have both values.
        saveCreds(currentGroupId, passkey);
        void saveBrowserCredential(currentGroupId, passkey);
        setPasskey("");
        console.log("[unlock] ✓ unlocked — handing config to app");
        onUnlock(config);
      } catch (error) {
        if (error instanceof RemoteCredentialsError) {
          console.log(`[unlock] ✗ locked: ${error.message}${error.detail ? ` — ${error.detail}` : ""}`);
          setMessage(error.message);
          setDetail(error.detail);
        } else {
          console.log(`[unlock] ✗ unexpected: ${error instanceof Error ? error.message : String(error)}`);
          setMessage("couldn't unlock the processor");
          setDetail(error instanceof Error ? error.message : String(error));
        }
        setStatus("error");
      }
    },
    [groupId, passkey, status, onUnlock],
  );

  const busy = status === "unlocking";
  const canSubmit = groupId.trim() !== "" && passkey !== "" && !busy;
  const c = tone(busy ? "blue" : status === "error" ? "red" : "neutral");

  return (
    <div className="pay-root" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "40px 26px", width: "100%" }}>
        <form onSubmit={submit} style={{ maxWidth: 380, width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: c.bg, color: c.solid, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 22 }}>
            <Icon name="lock" size={25} stroke={1.9} style={{ animation: busy ? "pay-spin 1.4s linear infinite" : "none" }} />
          </div>
          <h2 style={{ margin: 0, fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 23, color: "var(--text-1)", letterSpacing: "-0.02em", lineHeight: 1.15 }}>
            Unlock this terminal
          </h2>
          <p style={{ margin: "13px 0 0", fontSize: 14, lineHeight: 1.62, color: "var(--text-3)" }}>
            Enter your POS group and unlock passkey. The shop's credentials are fetched and decrypted on this device — nothing is stored in the app.
          </p>

          <div style={{ marginTop: 24, width: "100%" }}>
            <label htmlFor="merchant-group-id" style={labelStyle}>POS group</label>
            <input
              id="merchant-group-id"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={groupId}
              disabled={busy}
              onChange={(e) => setGroupId(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div style={{ marginTop: 14, width: "100%" }}>
            <label htmlFor="merchant-passkey" style={labelStyle}>Unlock passkey</label>
            <div style={{ position: "relative" }}>
              <input
                id="merchant-passkey"
                name="password"
                type={showPasskey ? "text" : "password"}
                autoComplete="current-password"
                value={passkey}
                disabled={busy}
                onChange={(e) => setPasskey(e.target.value)}
                style={{ ...inputStyle, paddingRight: 42 }}
              />
              <button
                type="button"
                onClick={() => setShowPasskey((v) => !v)}
                aria-label={showPasskey ? "Hide passkey" : "Show passkey"}
                style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", display: "inline-flex", padding: 6, background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}
              >
                <Icon name="eye" size={17} stroke={2} />
              </button>
            </div>
          </div>

          <div style={{ marginTop: 22, width: "100%" }}>
            <Btn kind="primary" size="md" icon="lock" full disabled={!canSubmit}>
              {busy ? "Unlocking…" : "Unlock"}
            </Btn>
          </div>

          <DisplayIf condition={status === "error" && message}>
            <p style={{ margin: "16px 0 0", fontSize: 13, lineHeight: 1.5, color: "var(--red-fg)" }}>{message}</p>
          </DisplayIf>

          <DisplayIf condition={status === "error" && detail}>
            <div style={{ marginTop: 12, width: "100%" }}>
              <button
                type="button"
                onClick={() => setShowDetail((v) => !v)}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-sans)", margin: "0 auto" }}
              >
                <Icon name="chevronDown" size={14} stroke={2} style={{ transform: showDetail ? "rotate(180deg)" : "none", transition: "transform .18s" }} />
                {showDetail ? "Hide technical details" : "Show technical details"}
              </button>
              <DisplayIf condition={showDetail}>
                <div className="mono" style={{ marginTop: 11, padding: "12px 14px", background: "var(--surface-3)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.55, textAlign: "left", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {detail}
                </div>
              </DisplayIf>
            </div>
          </DisplayIf>
        </form>
      </div>
    </div>
  );
}
