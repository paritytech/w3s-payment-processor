// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

export interface SaveFileOptions {
  readonly fileName: string;
  readonly content: string;
  readonly mimeType?: string;
}

interface WritableFileStream {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface SaveFilePickerHandle {
  createWritable(): Promise<WritableFileStream>;
}

type ShowSaveFilePicker = (options: {
  suggestedName?: string;
  types?: ReadonlyArray<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<SaveFilePickerHandle>;

export async function saveFile({
  fileName,
  content,
  mimeType = "application/json",
}: SaveFileOptions): Promise<void> {
  if (typeof document === "undefined") return;

  const picker = (globalThis as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const ext = extensionOf(fileName);
      const handle = await picker({
        suggestedName: fileName,
        ...(ext ? { types: [{ accept: { [mimeType]: [ext] } }] } : {}),
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    } catch (caught) {
      // User dismissed the native dialog — a deliberate cancel, not an error.
      if (isAbortError(caught)) return;
      // API present but unusable here → fall through to the anchor.
    }
  }

  const blob = new Blob([content], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has enqueued the download, never before.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot) : "";
}

function isAbortError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "AbortError"
  );
}
