import { expect, test } from "vitest";
import { formatRate, parseRate } from "./rate";

test("rates are typed as decimals and kept as whole millionths", () => {
  expect(parseRate("48.50")).toBe(48_500_000);
  expect(parseRate("48.5")).toBe(48_500_000);
  expect(parseRate("٤٨٫٧٥")).toBe(48_750_000);
  expect(parseRate("7.123456")).toBe(7_123_456);
  for (const bad of ["", "0", "-1", "1.1234567", "abc", "1,5"]) expect(parseRate(bad)).toBeNull();
  expect(formatRate(48_500_000)).toBe("48.50");
  expect(formatRate(7_123_456)).toBe("7.123456");
  expect(formatRate(49_000_000)).toBe("49.00");
});
