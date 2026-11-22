import { describe, expect, test } from "vitest";
import { formatMoney, parseMoney } from "./money";

describe("showing amounts", () => {
  test.each([
    [0, "0.00"],
    [5, "0.05"],
    [5_700, "57.00"],
    [18_642_075, "186,420.75"],
    [-12_345, "-123.45"],
  ])("%i piastres show as %s", (piastres, shown) => {
    expect(formatMoney(piastres)).toBe(shown);
  });
});

describe("reading typed amounts", () => {
  test.each([
    ["57", 5_700],
    ["57.5", 5_750],
    ["57.05", 5_705],
    ["1,250.75", 125_075],
    ["٥٧٫٥٠", 5_750],
    [" 12 ", 1_200],
    ["0", 0],
  ])("%s reads as %i piastres", (typed, piastres) => {
    expect(parseMoney(typed)).toBe(piastres);
  });

  test.each(["", "abc", "1.234", "-5", "1.2.3"])("%s is not an amount", (typed) => {
    expect(parseMoney(typed)).toBeNull();
  });
});

describe("digit style", () => {
  test("amounts and quantities can show in Arabic-Indic digits, and still read back", async () => {
    const { setDigitStyle } = await import("./digits");
    const { formatQuantity } = await import("./quantity");
    setDigitStyle("arabic");
    try {
      expect(formatMoney(18_642_075)).toBe("١٨٦٬٤٢٠٫٧٥");
      expect(formatQuantity(6_250)).toBe("٦٫٢٥");
      expect(parseMoney(formatMoney(18_642_075))).toBe(18_642_075);
    } finally {
      setDigitStyle("western");
    }
    expect(formatMoney(18_642_075)).toBe("186,420.75");
  });
});
