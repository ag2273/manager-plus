import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { accountByRole } from "./stock";

export type Shift = {
  id: number;
  userId: number;
  userName: string;
  openedAt: string;
  openingFloat: Piastres;
  closedAt: string | null;
  countedCash: Piastres | null;
  status: "open" | "closed";
};
export type CashInOut = { date: IsoDate; direction: "in" | "out"; amount: Piastres; accountId: number; reason: string };
export type CloseShiftInput = { date: IsoDate; countedCash: Piastres };
export type ZReport = {
  shift: Shift;
  receipts: number;
  sales: {
    total: Piastres;
    net: Piastres;
    vat: Piastres;
    /** Cash is after change; credit is what was left on customers' accounts. */
    byMethod: { cash: Piastres; card: Piastres; wallet: Piastres; credit: Piastres };
  };
  returns: Piastres;
  discounts: Piastres;
  cashIn: Piastres;
  cashOut: Piastres;
  openingFloat: Piastres;
  /** Float + cash taken for sales + cash in − cash out. */
  expectedCash: Piastres;
  countedCash: Piastres | null;
  /** Counted − expected: positive is cash over, negative cash short. */
  difference: Piastres | null;
};

type ShiftRow = {
  id: number;
  userId: number;
  userName: string;
  openedAt: string;
  openingFloat: number;
  closedAt: string | null;
  countedCash: number | null;
};

const SELECT_SHIFTS = `
  SELECT s.id, s.user_id AS userId, u.name AS userName, s.opened_at AS openedAt, s.opening_float AS openingFloat,
         s.closed_at AS closedAt, s.counted_cash AS countedCash
    FROM shifts s JOIN users u ON u.id = s.user_id`;

const toShift = (r: ShiftRow): Shift => ({ ...r, status: r.closedAt === null ? "open" : "closed" });

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new BusinessError("line_amount_invalid", `Amount ${amount} is not whole piastres`);
  }
}

export function openShiftOf(db: Database.Database, userId: number): Shift | null {
  const row = db.prepare(`${SELECT_SHIFTS} WHERE s.user_id = ? AND s.closed_at IS NULL`).get(userId) as ShiftRow | undefined;
  return row ? toShift(row) : null;
}

/** The user's open shift; every till command needs one. */
export function requireOpenShift(db: Database.Database, userId: number): Shift {
  const shift = openShiftOf(db, userId);
  if (!shift) throw new BusinessError("shift_required", "Open a shift first");
  return shift;
}

export function openShift(db: Database.Database, userId: number, openingFloat: Piastres): number {
  assertAmount(openingFloat);
  if (openShiftOf(db, userId)) throw new BusinessError("shift_already_open", "This user already has an open shift");
  return Number(
    db
      .prepare("INSERT INTO shifts (user_id, opened_at, opening_float) VALUES (?, ?, ?)")
      .run(userId, new Date().toISOString(), openingFloat).lastInsertRowid,
  );
}

/** Cash paid into the drawer (Dr Cash drawer, Cr account) or out of it (Dr account, Cr Cash drawer). */
export function cashInOut(db: Database.Database, userId: number, input: CashInOut): number {
  assertIsoDate(input.date);
  const shift = requireOpenShift(db, userId);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new BusinessError("line_amount_invalid", `Amount ${input.amount} is not a positive whole number of piastres`);
  }
  const drawer = accountByRole(db, "cash_drawer");
  if (input.accountId === drawer) throw new BusinessError("account_not_allowed", "Pick the account the cash comes from or goes to");
  const reason = input.reason.trim();
  const lines: JournalLine[] =
    input.direction === "in"
      ? [
          { accountId: drawer, debit: input.amount },
          { accountId: input.accountId, credit: input.amount },
        ]
      : [
          { accountId: input.accountId, debit: input.amount },
          { accountId: drawer, credit: input.amount },
        ];
  const memo = `${input.direction === "in" ? "إيداع في الدرج" : "صرف من الدرج"}${reason ? `: ${reason}` : ""}`;
  const entryId = postJournalEntry(db, { date: input.date, memo, lines }, "cash_movement");
  return Number(
    db
      .prepare(
        "INSERT INTO cash_movements (shift_id, at, direction, amount, account_id, reason, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(shift.id, new Date().toISOString(), input.direction, input.amount, input.accountId, reason, entryId).lastInsertRowid,
  );
}

function findShift(db: Database.Database, id: number): Shift {
  const row = db.prepare(`${SELECT_SHIFTS} WHERE s.id = ?`).get(id) as ShiftRow | undefined;
  if (!row) throw new BusinessError("shift_not_found", `No shift with id ${id}`);
  return toShift(row);
}

export function zReport(db: Database.Database, id: number): ZReport {
  const shift = findShift(db, id);
  const sales = db
    .prepare(
      `SELECT COUNT(DISTINCT r.id) AS receipts, COALESCE(SUM(l.gross), 0) AS total,
              COALESCE(SUM(l.net), 0) AS net, COALESCE(SUM(l.vat), 0) AS vat
         FROM sales_receipts r LEFT JOIN sales_receipt_lines l ON l.receipt_id = r.id
        WHERE r.shift_id = ?`,
    )
    .get(id) as { receipts: number; total: number; net: number; vat: number };
  const paid = db
    .prepare(
      `SELECT p.method, SUM(p.amount) AS amount
         FROM sales_receipt_payments p JOIN sales_receipts r ON r.id = p.receipt_id
        WHERE r.shift_id = ? GROUP BY p.method`,
    )
    .all(id) as { method: "cash" | "card" | "wallet"; amount: number }[];
  const byMethod = { cash: 0, card: 0, wallet: 0, credit: 0 };
  for (const p of paid) byMethod[p.method] = p.amount;
  byMethod.credit = sales.total - byMethod.cash - byMethod.card - byMethod.wallet;
  const cash = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount END), 0) AS cashIn,
              COALESCE(SUM(CASE WHEN direction = 'out' THEN amount END), 0) AS cashOut
         FROM cash_movements WHERE shift_id = ?`,
    )
    .get(id) as { cashIn: number; cashOut: number };
  const expectedCash = shift.openingFloat + byMethod.cash + cash.cashIn - cash.cashOut;
  return {
    shift,
    receipts: sales.receipts,
    sales: { total: sales.total, net: sales.net, vat: sales.vat, byMethod },
    returns: 0,
    discounts: 0,
    cashIn: cash.cashIn,
    cashOut: cash.cashOut,
    openingFloat: shift.openingFloat,
    expectedCash,
    countedCash: shift.countedCash,
    difference: shift.countedCash === null ? null : shift.countedCash - expectedCash,
  };
}

/** Closes the user's shift with the cash counted; the difference posts to Cash over or Cash short. */
export function closeShift(db: Database.Database, userId: number, input: CloseShiftInput): ZReport {
  assertIsoDate(input.date);
  assertAmount(input.countedCash);
  const shift = requireOpenShift(db, userId);
  const difference = input.countedCash - zReport(db, shift.id).expectedCash;
  let entryId: number | null = null;
  if (difference !== 0) {
    const drawer = accountByRole(db, "cash_drawer");
    const lines: JournalLine[] =
      difference > 0
        ? [
            { accountId: drawer, debit: difference },
            { accountId: accountByRole(db, "cash_over"), credit: difference },
          ]
        : [
            { accountId: accountByRole(db, "cash_short"), debit: -difference },
            { accountId: drawer, credit: -difference },
          ];
    entryId = postJournalEntry(db, { date: input.date, memo: `إغلاق وردية رقم ${shift.id}`, lines }, "shift_close");
  }
  db.prepare("UPDATE shifts SET closed_at = ?, counted_cash = ?, close_entry_id = ? WHERE id = ?").run(
    new Date().toISOString(),
    input.countedCash,
    entryId,
    shift.id,
  );
  return zReport(db, shift.id);
}

/** Shifts, newest first. */
export function listShifts(db: Database.Database, limit = 200): Shift[] {
  return (db.prepare(`${SELECT_SHIFTS} ORDER BY s.id DESC LIMIT ?`).all(limit) as ShiftRow[]).map(toShift);
}
