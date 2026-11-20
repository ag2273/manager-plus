import type Database from "better-sqlite3";
import type { Piastres } from "./ledger";
import type { Quantity } from "./items";

/** How much of a posted line's values earlier documents already took back. */
export type Taken = { quantity: Quantity; values: Piastres[] };

/**
 * The share of a line's values for `quantity` out of the line's `whole` quantity. The
 * part that takes the last of the line gets exactly what is left, so taking a line
 * back in pieces never loses or invents a piastre.
 */
export function shareOf(values: Piastres[], whole: Quantity, before: Taken, quantity: Quantity): Piastres[] {
  const last = before.quantity + quantity === whole;
  return values.map((value, i) => (last ? value - (before.values[i] ?? 0) : Math.round((value * quantity) / whole)));
}

/** Adds a share to what was taken. */
export function take(before: Taken, quantity: Quantity, share: Piastres[]): Taken {
  return { quantity: before.quantity + quantity, values: share.map((v, i) => v + (before.values[i] ?? 0)) };
}

/** Next number in a gap-free sequence; call inside the posting transaction. */
export function nextNumber(db: Database.Database, table: string, where = "1 = 1", ...args: unknown[]): number {
  return (db.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;
}
