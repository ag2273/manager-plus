import type { Quantity } from "../core/items";

/** Shows a quantity in thousandths as base units: 12000 → "12", 6250 → "6.25". */
export function formatQuantity(quantity: Quantity): string {
  const whole = Math.trunc(quantity / 1000);
  const rest = Math.abs(quantity % 1000);
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(3, "0").replace(/0+$/, "")}`;
}

/** Reads a typed quantity ("12", "6.25", Arabic-Indic digits) into thousandths. Null when it isn't one. */
export function parseQuantity(text: string): Quantity | null {
  const clean = text
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, ".");
  const match = /^(\d+)(?:\.(\d{0,3}))?$/.exec(clean);
  if (!match) return null;
  const quantity = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  return Number.isSafeInteger(quantity) ? quantity : null;
}
