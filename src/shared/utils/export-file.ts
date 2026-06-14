// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { detectHostEnvironment } from "@/shared/api/host/connection.ts";
import { useExportFallbackStore } from "@/shared/store/use-export-fallback-store.ts";
import { saveFile, type SaveFileOptions } from "@/shared/utils/download.ts";

/**
 * Deliver `content` to the user as a file, across every shell this app runs in:
 *   1. `navigator.share({ files })` — the native "Save to Files" sheet, the only
 *      file save that works in the iOS host (WKWebView has no download delegate)
 *      and the route mobile shells prefer.
 *   2. dot.li web-iframe — the sandbox omits `allow-downloads` and the host
 *      doesn't delegate web-share, so neither (1) nor a download fires; copy to
 *      the clipboard and open a panel holding the text for manual save.
 *   3. Desktop / standalone browser — a real `<a download>` save.
 */
export async function exportFile({
  fileName,
  content,
  mimeType = "application/json",
}: SaveFileOptions): Promise<void> {
  const file = new File([content], fileName, { type: mimeType });
  if (typeof navigator.share === "function" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return;
    } catch (caught) {
      // AbortError = user dismissed the sheet (a deliberate cancel), so stop.
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      // Share not permitted in this shell (e.g. dot.li iframe) → fall through.
    }
  }

  if (detectHostEnvironment() === "web-iframe") {
    try {
      void navigator.clipboard?.writeText(content);
    } catch {
      /* clipboard unavailable (plain-HTTP / denied) — the panel still allows manual selection */
    }
    useExportFallbackStore.getState().open(fileName, content);
    return;
  }

  void saveFile({ fileName, content, mimeType });
}
