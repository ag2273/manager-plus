import { expect, test } from "vitest";
import { formatQuantity, parseQuantity } from "./quantity";

test.each([
  [12_000, "12"],
  [6_250, "6.25"],
  [1, "0.001"],
  [0, "0"],
])("%i thousandths show as %s", (q, shown) => {
  expect(formatQuantity(q)).toBe(shown);
});

test.each([
  ["12", 12_000],
  ["6.25", 6_250],
  ["٢٤", 24_000],
  ["0.5", 500],
])("%s reads as %i thousandths", (typed, q) => {
  expect(parseQuantity(typed)).toBe(q);
});

test.each(["", "x", "1.2345", "-1"])("%s is not a quantity", (typed) => {
  expect(parseQuantity(typed)).toBeNull();
});
