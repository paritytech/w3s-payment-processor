// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { create } from "zustand";

export interface ExportFallbackState {
  readonly fileName: string | null;
  readonly content: string | null;
  open(fileName: string, content: string): void;
  close(): void;
}

export const useExportFallbackStore = create<ExportFallbackState>((set) => ({
  fileName: null,
  content: null,
  open: (fileName, content) => set({ fileName, content }),
  close: () => set({ fileName: null, content: null }),
}));
