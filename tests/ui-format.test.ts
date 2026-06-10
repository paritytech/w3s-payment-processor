import { describe, expect, it } from "vitest";

import { fmtCash, fmtDayHour, fmtHour, fmtInt, fmtTime, groupByHour, tillColor, toToken } from "@/shared/utils/ui-format.ts";

const at = (h: number, m: number) => new Date(2026, 5, 5, h, m, 0, 0).getTime();

describe("toToken", () => {
  it("converts integer planck to token units at the given decimals", () => {
    expect(toToken("6000000", 6)).toBe(6);
    expect(toToken("8500000", 6)).toBe(8.5);
    expect(toToken("109000000", 6)).toBe(109);
    expect(toToken(2_640_000_000n, 6)).toBe(2640);
  });

  it("treats empty / zero as 0 and respects non-6 decimals", () => {
    expect(toToken("", 6)).toBe(0);
    expect(toToken("0", 6)).toBe(0);
    expect(toToken("1250", 2)).toBe(12.5);
  });
});

describe("fmtCash / fmtInt", () => {
  it("always shows two decimals with grouped thousands", () => {
    expect(fmtCash(9.08)).toBe("9.08");
    expect(fmtCash(1740)).toBe("1,740.00");
    expect(fmtCash(0)).toBe("0.00");
  });

  it("groups integers without decimals", () => {
    expect(fmtInt(1234)).toBe("1,234");
    expect(fmtInt(0)).toBe("0");
  });
});

describe("fmtTime / fmtHour 12-hour boundaries", () => {
  it("renders AM/PM time including noon and midnight", () => {
    expect(fmtTime(at(19, 42))).toBe("7:42 PM");
    expect(fmtTime(at(9, 5))).toBe("9:05 AM");
    expect(fmtTime(at(0, 0))).toBe("12:00 AM");
    expect(fmtTime(at(12, 7))).toBe("12:07 PM");
  });

  it("buckets to the hour with the same 12-hour rules", () => {
    expect(fmtHour(at(19, 42))).toBe("7:00 PM");
    expect(fmtHour(at(0, 30))).toBe("12:00 AM");
    expect(fmtHour(at(12, 15))).toBe("12:00 PM");
    expect(fmtHour(at(13, 0))).toBe("1:00 PM");
  });
});

describe("groupByHour", () => {
  it("coalesces only adjacent same-hour items, preserving order", () => {
    const items = [
      { tsMs: at(19, 40) },
      { tsMs: at(19, 10) },
      { tsMs: at(18, 50) },
      { tsMs: at(18, 5) },
      { tsMs: at(19, 1) }, // non-adjacent 7 PM → its own bucket
    ];
    const groups = groupByHour(items);
    expect(groups.map((g) => g.hour)).toEqual(["7:00 PM", "6:00 PM", "7:00 PM"]);
    expect(groups.map((g) => g.items.length)).toEqual([2, 2, 1]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupByHour([])).toEqual([]);
  });

  it("keeps same-hour items from different days apart under a day-qualified label", () => {
    const atDay = (d: number, h: number, m: number) => new Date(2026, 5, d, h, m, 0, 0).getTime();
    const items = [
      { tsMs: atDay(6, 14, 40) }, // Jun 6, 2 PM
      { tsMs: atDay(6, 14, 5) },
      { tsMs: atDay(5, 14, 50) }, // Jun 5, 2 PM — adjacent same hour, different day
    ];
    // Default hour-only labels would merge all three into one bucket.
    expect(groupByHour(items).map((g) => g.items.length)).toEqual([3]);
    const groups = groupByHour(items, fmtDayHour);
    expect(groups.map((g) => g.hour)).toEqual(["Jun 6 · 2:00 PM", "Jun 5 · 2:00 PM"]);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1]);
  });
});

describe("tillColor", () => {
  it("is deterministic per id and emits an oklch swatch", () => {
    expect(tillColor("till-1")).toBe(tillColor("till-1"));
    expect(tillColor("till-1")).toMatch(/^oklch\(/);
  });
});
