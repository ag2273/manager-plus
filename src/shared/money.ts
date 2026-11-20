import type { Piastres } from "../core/ledger";

const ARABIC_INDIC = /[٠-٩]/g;

/** Shows piastres as pounds with two decimals and thousands separators: 18642075 → "186,420.75". */
export function formatMoney(amount: Piastres): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const pounds = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}${pounds}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Reads what someone typed as an amount in pounds ("57", "57.5", "1,250.75",
 * Arabic-Indic digits too) into piastres. Returns null when it isn't an amount.
 */
export function parseMoney(text: string): Piastres | null {
  const clean = text
    .trim()
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, ".")
    .replace(/[,٬\s]/g, "");
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(clean);
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}
