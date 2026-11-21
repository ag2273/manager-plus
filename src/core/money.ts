import type Database from "better-sqlite3";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { assertPostable, findSupplier } from "./purchases";
import { nextNumber } from "./shares";
import { accountByRole } from "./stock";

/** Cash, bank and wallet accounts: the system ones, and any asset account the user adds in the 11xx cash and bank group. */
export type MoneyAccount = { id: number; code: string; name: string; balance: Piastres };
export type ExpenseInput = {
  date: IsoDate;
  /** An expense account from the chart. */
  expenseAccountId: number;
  /** Without VAT. */
  amount: Piastres;
  /** Input VAT on the bill, if any. */
  vat: Piastres;
  /** Paid from a money account now, or owed to a supplier. */
  paidFrom: { accountId: number } | { supplierId: number };
  memo: string;
};
export type Expense = {
  id: number;
  number: number;
  date: IsoDate;
  accountName: string;
  amount: Piastres;
  vat: Piastres;
  /** The money account or supplier's name. */
  paidFrom: string;
  memo: string;
  entryId: number;
  voided: boolean;
};
export type MoneyTransferInput = { date: IsoDate; fromAccountId: number; toAccountId: number; amount: Piastres; memo: string };
export type MoneyTransfer = {
  id: number;
  number: number;
  date: IsoDate;
  from: string;
  to: string;
  amount: Piastres;
  memo: string;
  entryId: number;
  voided: boolean;
};
export type PostedDocument = { id: number; number: number; entryId: number };
export type AccountLine = { lineId: number; entryId: number; date: IsoDate; memo: string; debit: Piastres; credit: Piastres; cleared: boolean };
export type Reconciliation = {
  /** Every posting to the account. */
  balance: Piastres;
  /** The lines ticked as on the bank statement. */
  cleared: Piastres;
  statement: Piastres;
  /** Statement less cleared: zero when the ticked lines match the statement. */
  difference: Piastres;
};

const MONEY_ROLES = ["cash_drawer", "main_cash", "bank", "wallet", "card_clearing"];
/** Entries with no document of their own behind them, so voiding the entry voids the whole thing. */
const VOIDABLE = ["journal", "expense", "money_transfer"];

const MONEY_WHERE = `a.active = 1 AND a.type = 'asset' AND (a.role IN (${MONEY_ROLES.map((r) => `'${r}'`).join(", ")}) OR (a.role IS NULL AND a.code LIKE '11%'))`;

export function listMoneyAccounts(db: Database.Database, asOf: IsoDate): MoneyAccount[] {
  assertIsoDate(asOf);
  return db
    .prepare(
      `SELECT a.id, a.code, a.name,
              COALESCE((SELECT SUM(l.debit) - SUM(l.credit) FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
                         WHERE l.account_id = a.id AND e.date <= ?), 0) AS balance
         FROM accounts a WHERE ${MONEY_WHERE} ORDER BY a.code`,
    )
    .all(asOf) as MoneyAccount[];
}

function moneyAccount(db: Database.Database, id: number): { id: number; name: string } {
  const row = db.prepare(`SELECT a.id, a.name FROM accounts a WHERE a.id = ? AND ${MONEY_WHERE}`).get(id) as { id: number; name: string } | undefined;
  if (!row) throw new BusinessError("account_not_allowed", `Account ${id} is not a cash, bank or wallet account`);
  return row;
}

function assertAmount(amount: number, allowZero = false): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || (!allowZero && amount === 0)) {
    throw new BusinessError("amount_invalid", `Amount ${amount} is not whole piastres`);
  }
}

/** An expense: Dr the expense account (and Input VAT), Cr the money account it was paid from or the supplier owed. */
export function recordExpense(db: Database.Database, input: ExpenseInput, userId: number): PostedDocument {
  assertIsoDate(input.date);
  assertAmount(input.amount);
  assertAmount(input.vat, true);
  const expense = db.prepare("SELECT id FROM accounts WHERE id = ? AND type = 'expense' AND active = 1").get(input.expenseAccountId);
  if (!expense) throw new BusinessError("account_not_allowed", `Account ${input.expenseAccountId} is not an expense account`);
  const total = input.amount + input.vat;
  let credit: JournalLine;
  let paidFrom: { moneyAccountId: number | null; supplierId: number | null; name: string };
  if ("supplierId" in input.paidFrom) {
    const supplier = findSupplier(db, input.paidFrom.supplierId);
    assertPostable(supplier);
    if (supplier.currency !== "EGP") throw new BusinessError("payee_not_egp", `${supplier.name} bills in ${supplier.currency}`);
    credit = { accountId: accountByRole(db, "payables"), credit: total, supplierId: supplier.id };
    paidFrom = { moneyAccountId: null, supplierId: supplier.id, name: supplier.name };
  } else {
    const account = moneyAccount(db, input.paidFrom.accountId);
    credit = { accountId: account.id, credit: total };
    paidFrom = { moneyAccountId: account.id, supplierId: null, name: account.name };
  }
  const number = nextNumber(db, "expenses");
  const memo = input.memo.trim();
  const lines: JournalLine[] = [{ accountId: input.expenseAccountId, debit: input.amount }];
  if (input.vat > 0) lines.push({ accountId: accountByRole(db, "input_vat"), debit: input.vat });
  lines.push(credit);
  const entryId = postJournalEntry(
    db,
    { date: input.date, memo: `مصروف رقم ${number} - ${paidFrom.name}${memo ? ` - ${memo}` : ""}`, lines },
    "expense",
  );
  const id = Number(
    db
      .prepare(
        `INSERT INTO expenses (number, date, account_id, amount, vat, money_account_id, supplier_id, memo, entry_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(number, input.date, input.expenseAccountId, input.amount, input.vat, paidFrom.moneyAccountId, paidFrom.supplierId, memo, entryId, userId)
      .lastInsertRowid,
  );
  return { id, number, entryId };
}

export function listExpenses(db: Database.Database): Expense[] {
  return (
    db
      .prepare(
        `SELECT x.id, x.number, x.date, a.name AS accountName, x.amount, x.vat, COALESCE(m.name, s.name) AS paidFrom, x.memo, x.entry_id AS entryId,
                e.voided_by IS NOT NULL AS voided
           FROM expenses x JOIN accounts a ON a.id = x.account_id JOIN journal_entries e ON e.id = x.entry_id
           LEFT JOIN accounts m ON m.id = x.money_account_id LEFT JOIN suppliers s ON s.id = x.supplier_id
          ORDER BY x.number DESC`,
      )
      .all() as (Omit<Expense, "voided"> & { voided: number })[]
  ).map((x) => ({ ...x, voided: x.voided === 1 }));
}

/** Money moved between two of the business's own accounts: Dr the one it goes into, Cr the one it leaves. */
export function transferMoney(db: Database.Database, input: MoneyTransferInput, userId: number): PostedDocument {
  assertIsoDate(input.date);
  assertAmount(input.amount);
  const from = moneyAccount(db, input.fromAccountId);
  const to = moneyAccount(db, input.toAccountId);
  if (from.id === to.id) throw new BusinessError("account_not_allowed", "A transfer needs two different accounts");
  const number = nextNumber(db, "money_transfers");
  const memo = input.memo.trim();
  const entryId = postJournalEntry(
    db,
    {
      date: input.date,
      memo: `تحويل رقم ${number} من ${from.name} إلى ${to.name}${memo ? ` - ${memo}` : ""}`,
      lines: [
        { accountId: to.id, debit: input.amount },
        { accountId: from.id, credit: input.amount },
      ],
    },
    "money_transfer",
  );
  const id = Number(
    db
      .prepare(
        "INSERT INTO money_transfers (number, date, from_account_id, to_account_id, amount, memo, entry_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(number, input.date, from.id, to.id, input.amount, memo, entryId, userId).lastInsertRowid,
  );
  return { id, number, entryId };
}

export function listMoneyTransfers(db: Database.Database): MoneyTransfer[] {
  return (
    db
      .prepare(
        `SELECT t.id, t.number, t.date, f.name AS "from", o.name AS "to", t.amount, t.memo, t.entry_id AS entryId, e.voided_by IS NOT NULL AS voided
           FROM money_transfers t JOIN accounts f ON f.id = t.from_account_id JOIN accounts o ON o.id = t.to_account_id
           JOIN journal_entries e ON e.id = t.entry_id
          ORDER BY t.number DESC`,
      )
      .all() as (Omit<MoneyTransfer, "voided"> & { voided: number })[]
  ).map((t) => ({ ...t, voided: t.voided === 1 }));
}

/** Every posting to an account between two dates, with whether it is ticked as on the statement. */
export function accountLines(db: Database.Database, accountId: number, from: IsoDate, to: IsoDate): AccountLine[] {
  assertIsoDate(from);
  assertIsoDate(to);
  if (from > to) throw new BusinessError("date_range_invalid", `${from} is after ${to}`);
  return (
    db
      .prepare(
        `SELECT l.id AS lineId, e.id AS entryId, e.date, e.memo, l.debit, l.credit, l.cleared
           FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.account_id = ? AND e.date BETWEEN ? AND ?
          ORDER BY e.date, l.id`,
      )
      .all(accountId, from, to) as (Omit<AccountLine, "cleared"> & { cleared: number })[]
  ).map((l) => ({ ...l, cleared: l.cleared === 1 }));
}

export function setCleared(db: Database.Database, accountId: number, lineIds: number[], cleared: boolean): void {
  const owner = db.prepare("SELECT account_id AS accountId FROM ledger_lines WHERE id = ?");
  const update = db.prepare("UPDATE ledger_lines SET cleared = ? WHERE id = ?");
  for (const id of lineIds) {
    const row = owner.get(id) as { accountId: number } | undefined;
    if (!row || row.accountId !== accountId) throw new BusinessError("line_not_found", `Line ${id} is not on account ${accountId}`);
    update.run(cleared ? 1 : 0, id);
  }
}

export function reconciliation(db: Database.Database, accountId: number, statement: Piastres): Reconciliation {
  if (!Number.isSafeInteger(statement)) throw new BusinessError("amount_invalid", `Statement balance ${statement} is not whole piastres`);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance,
              COALESCE(SUM(CASE WHEN cleared = 1 THEN debit - credit ELSE 0 END), 0) AS cleared
         FROM ledger_lines WHERE account_id = ?`,
    )
    .get(accountId) as { balance: number; cleared: number };
  return { ...row, statement, difference: statement - row.cleared };
}

export function lockDate(db: Database.Database): IsoDate | null {
  const row = db.prepare("SELECT lock_date AS lockDate FROM business_settings WHERE id = 1").get() as { lockDate: string | null } | undefined;
  return row?.lockDate ?? null;
}

export function setLockDate(db: Database.Database, date: IsoDate | null): void {
  if (date !== null) assertIsoDate(date);
  db.prepare("UPDATE business_settings SET lock_date = ? WHERE id = 1").run(date);
}

/**
 * Voids a journal entry, an expense or a transfer by posting its reverse on `date`. Both stay in
 * the ledger, so the history shows what was posted and when it was undone; to edit, void and
 * post again. Documents with their own undo (invoices, receipts, sales) are refused.
 */
export function voidEntry(db: Database.Database, entryId: number, date: IsoDate): number {
  assertIsoDate(date);
  const entry = db.prepare("SELECT id, date, memo, kind, voided_by AS voidedBy FROM journal_entries WHERE id = ?").get(entryId) as
    | { id: number; date: string; memo: string; kind: string; voidedBy: number | null }
    | undefined;
  if (!entry) throw new BusinessError("entry_not_found", `No journal entry with id ${entryId}`);
  if (!VOIDABLE.includes(entry.kind)) throw new BusinessError("entry_not_voidable", `A ${entry.kind} entry is undone through its own document`);
  if (entry.voidedBy !== null) throw new BusinessError("entry_voided", `Entry ${entryId} is already void`);
  if (date < entry.date) throw new BusinessError("date_range_invalid", `The void date ${date} is before the entry's ${entry.date}`);
  const lines = db
    .prepare(
      `SELECT account_id AS accountId, debit, credit, memo, supplier_id AS supplierId, customer_id AS customerId, foreign_amount AS foreignAmount
         FROM ledger_lines WHERE entry_id = ? ORDER BY id`,
    )
    .all(entryId) as {
    accountId: number;
    debit: number;
    credit: number;
    memo: string;
    supplierId: number | null;
    customerId: number | null;
    foreignAmount: number | null;
  }[];
  const reversed: JournalLine[] = lines.map((l) => ({
    accountId: l.accountId,
    ...(l.debit > 0 ? { credit: l.debit } : { debit: l.credit }),
    memo: l.memo,
    ...(l.supplierId === null ? {} : { supplierId: l.supplierId }),
    ...(l.customerId === null ? {} : { customerId: l.customerId }),
    ...(l.foreignAmount === null ? {} : { foreign: l.foreignAmount }),
  }));
  const reversal = postJournalEntry(db, { date, memo: `إلغاء: ${entry.memo}`, lines: reversed }, "reversal");
  db.prepare("UPDATE journal_entries SET voided_by = ? WHERE id = ?").run(reversal, entryId);
  return reversal;
}
