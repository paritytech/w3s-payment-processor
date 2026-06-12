// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * `readSampleRate` — regression for the old `Number(env ?? "1") || 1` parse,
 * which coerced an explicit "0" (sampling off) back to 1.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { readSampleRate } from "@/shared/utils/env.ts";

const KEY = "VITE_TEST_SAMPLE_RATE";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readSampleRate", () => {
  it("falls back when unset", () => {
    expect(readSampleRate(KEY, 1)).toBe(1);
  });

  it("honors an explicit 0", () => {
    vi.stubEnv(KEY, "0");
    expect(readSampleRate(KEY, 1)).toBe(0);
  });

  it("parses fractional rates", () => {
    vi.stubEnv(KEY, "0.5");
    expect(readSampleRate(KEY, 1)).toBe(0.5);
  });

  it.each(["2", "-0.1", "abc", " "])("falls back on %j", (raw) => {
    vi.stubEnv(KEY, raw);
    expect(readSampleRate(KEY, 1)).toBe(1);
  });
});
