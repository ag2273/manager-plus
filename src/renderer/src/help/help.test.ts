import { describe, expect, it } from "vitest";
import { helpAr } from "./ar";
import { helpEn } from "./en";
import { fold, searchHelp } from "./index";

describe("the built-in help", () => {
  it("has the same guides and concepts in Arabic and English", () => {
    expect(helpAr.guides.map((g) => g.id)).toEqual(helpEn.guides.map((g) => g.id));
    expect(helpAr.concepts.map((c) => c.id)).toEqual(helpEn.concepts.map((c) => c.id));
    for (const [i, g] of helpAr.guides.entries()) {
      expect(g.steps.map((s) => s.screen)).toEqual(helpEn.guides[i]!.steps.map((s) => s.screen));
    }
  });

  it("links each screen only to guides that exist", () => {
    for (const content of [helpAr, helpEn]) {
      const ids = new Set(content.guides.map((g) => g.id));
      for (const s of Object.values(content.screens)) for (const g of s.guides) expect(ids.has(g)).toBe(true);
    }
  });

  it("finds Arabic words whatever the hamza, taa marbuta or diacritics", () => {
    expect(fold("الأرصدة الإفتتاحيّة")).toBe(fold("الارصده الافتتاحيه"));
    const hits = searchHelp(helpAr, "ارصده افتتاحيه");
    expect(hits[0]?.title).toContain("أرصدة");
  });

  it("finds English words in any case, titles first", () => {
    const hits = searchHelp(helpEn, "Z REPORT");
    expect(hits[0]).toMatchObject({ kind: "guide", id: "closeShift" });
  });

  it("finds nothing for nothing", () => {
    expect(searchHelp(helpEn, "  ")).toEqual([]);
    expect(searchHelp(helpEn, "zzzz")).toEqual([]);
  });
});
