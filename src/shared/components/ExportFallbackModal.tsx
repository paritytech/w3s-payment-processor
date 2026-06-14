// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { useEffect, useState } from "react";

import { Btn } from "@/shared/components/controls.tsx";
import { useExportFallbackStore } from "@/shared/store/use-export-fallback-store.ts";

/**
 * Manual-save fallback for shells that can't save files directly (dot.li
 * iframe). `exportFile` redirects here after putting the content on the
 * clipboard; this surfaces it for manual save.
 */
export function ExportFallbackModal() {
  const fileName = useExportFallbackStore((s) => s.fileName);
  const content = useExportFallbackStore((s) => s.content);
  const close = useExportFallbackStore((s) => s.close);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (fileName == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileName, close]);

  useEffect(() => {
    setCopied(false);
  }, [fileName]);

  if (fileName == null || content == null) return null;

  function copy() {
    void navigator.clipboard?.writeText(content ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }

  return (
    <>
      <div
        onClick={close}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, backdropFilter: "blur(2px)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Copy ${fileName}`}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(640px, calc(100vw - 32px))",
          maxHeight: "85dvh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          padding: 16,
          zIndex: 301,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>{fileName}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, lineHeight: 1.5 }}>
          This app shell can&rsquo;t save files directly. The contents are on your clipboard — paste
          them into a file named <span style={{ color: "var(--text-2)" }}>{fileName}</span>, or select
          and copy below.
        </div>
        <textarea
          readOnly
          value={content}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            marginTop: 12,
            flex: 1,
            minHeight: 200,
            width: "100%",
            boxSizing: "border-box",
            resize: "none",
            background: "var(--surface-3)",
            color: "var(--text-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: 10,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          <Btn kind="ghost" size="sm" icon="copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Btn>
          <Btn kind="ghost" size="sm" onClick={close}>
            Close
          </Btn>
        </div>
      </div>
    </>
  );
}
