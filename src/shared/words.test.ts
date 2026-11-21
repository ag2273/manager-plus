import { describe, expect, test } from "vitest";
import { amountInWords, numberInWords } from "./words";

describe("amounts in Arabic words", () => {
  test.each([
    [0, "صفر"],
    [1, "واحد"],
    [11, "أحد عشر"],
    [12, "اثنا عشر"],
    [21, "واحد وعشرون"],
    [100, "مائة"],
    [121, "مائة وواحد وعشرون"],
    [200, "مائتان"],
    [1_000, "ألف"],
    [1_001, "ألف وواحد"],
    [2_000, "ألفان"],
    [3_000, "ثلاثة آلاف"],
    [11_000, "أحد عشر ألف"],
    [150_000, "مائة وخمسون ألف"],
    [1_000_000, "مليون"],
    [2_500_000, "مليونان وخمسمائة ألف"],
    [7_000_000_000, "سبعة مليارات"],
  ])("%i is %s", (n, words) => {
    expect(numberInWords(n)).toBe(words);
  });

  test("piastres are written as pounds and piastres", () => {
    expect(amountInWords(12_100)).toBe("فقط مائة وواحد وعشرون جنيه مصري لا غير");
    expect(amountInWords(1_486)).toBe("فقط أربعة عشر جنيه مصري وستة وثمانون قرش لا غير");
    expect(amountInWords(50)).toBe("فقط خمسون قرش لا غير");
    expect(amountInWords(0)).toBe("فقط صفر جنيه مصري لا غير");
    expect(amountInWords(250_000_050)).toBe("فقط مليونان وخمسمائة ألف جنيه مصري وخمسون قرش لا غير");
  });
});

describe("amounts in English words", () => {
  test.each([
    [12_100, "Only one hundred twenty-one Egyptian pounds"],
    [100, "Only one Egyptian pound"],
    [0, "Only zero Egyptian pounds"],
    [5, "Only five piastres"],
    [123_456_789, "Only one million two hundred thirty-four thousand five hundred sixty-seven Egyptian pounds and eighty-nine piastres"],
    [100_000_100_000, "Only one billion one thousand Egyptian pounds"],
  ])("%i piastres", (piastres, words) => {
    expect(amountInWords(piastres, "en")).toBe(words);
  });
});
