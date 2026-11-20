import type Database from "better-sqlite3";
import type { AccountRole, AccountType } from "./chart-of-accounts";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";

/** Whole piastres (1/100 EGP). Never a fraction. */
export type Piastres = number;
/** A calendar date as YYYY-MM-DD. */
export type IsoDate = string;

export type Account = {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  role: AccountRole | null;
  active: boolean;
};

export type JournalLine = {
  accountId: number;
  debit?: Piastres;
  credit?: Piastres;
  memo?: string;
  /** The supplier a payables line belongs to. */
  supplierId?: number;
  /** The customer a receivables line belongs to. */
  customerId?: number;
};
export type JournalEntryInput = { date: IsoDate; memo: string; lines: JournalLine[] };

export type TrialBalanceRow = {
  accountId: number;
  code: string;
  name: string;
  type: AccountType;
  debit: Piastres;
  credit: Piastres;
};
export type TrialBalance = { rows: TrialBalanceRow[]; totalDebit: Piastres; totalCredit: Piastres };

type AccountRow = { id: number; code: string; name: string; type: AccountType; role: AccountRole | null; active: number };

function toAccount(row: AccountRow): Account {
  return { ...row, active: row.active === 1 };
}

export function listAccounts(db: Database.Database): Account[] {
  return (db.prepare("SELECT id, code, name, type, role, active FROM accounts ORDER BY code").all() as AccountRow[]).map(
    toAccount,
  );
}

export function trialBalance(db: Database.Database, asOf: IsoDate): TrialBalance {
  const sums = db
    .prepare(
      `SELECT a.id AS accountId, a.code, a.name, a.type,
              SUM(l.debit) AS debit, SUM(l.credit) AS credit
         FROM ledger_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE e.date <= ?
        GROUP BY a.id
        ORDER BY a.code`,
    )
    .all(asOf) as TrialBalanceRow[];
  const rows = sums
    .map((r) => {
      const net = r.debit - r.credit;
      return { ...r, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0);
  return {
    rows,
    totalDebit: rows.reduce((t, r) => t + r.debit, 0),
    totalCredit: rows.reduce((t, r) => t + r.credit, 0),
  };
}

function isPiastres(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function validateEntry(db: Database.Database, input: JournalEntryInput): void {
  assertIsoDate(input.date);
  if (input.lines.length < 2) {
    throw new BusinessError("entry_needs_two_lines", "A journal entry needs at least two lines");
  }
  let debits = 0;
  let credits = 0;
  const findAccount = db.prepare("SELECT active FROM accounts WHERE id = ?");
  for (const line of input.lines) {
    const hasDebit = line.debit !== undefined && line.debit !== 0;
    const hasCredit = line.credit !== undefined && line.credit !== 0;
    const amount = hasDebit ? line.debit : line.credit;
    if (hasDebit === hasCredit || !isPiastres(amount)) {
      throw new BusinessError("line_amount_invalid", "Each line needs either a debit or a credit, in whole piastres");
    }
    if (hasDebit) debits += amount;
    else credits += amount;
    const account = findAccount.get(line.accountId) as { active: number } | undefined;
    if (!account) throw new BusinessError("account_not_found", `No account with id ${line.accountId}`);
    if (account.active !== 1) throw new BusinessError("account_inactive", `Account ${line.accountId} is inactive`);
  }
  if (debits !== credits) {
    throw new BusinessError("entry_unbalanced", `Debits ${debits} do not equal credits ${credits}`);
  }
}

export function postJournalEntry(db: Database.Database, input: JournalEntryInput, kind = "journal"): number {
  validateEntry(db, input);
  const entry = db
    .prepare("INSERT INTO journal_entries (date, memo, kind) VALUES (?, ?, ?)")
    .run(input.date, input.memo.trim(), kind);
  const entryId = Number(entry.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO ledger_lines (entry_id, account_id, debit, credit, memo, supplier_id, customer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const line of input.lines) {
    insert.run(entryId, line.accountId, line.debit ?? 0, line.credit ?? 0, line.memo ?? "", line.supplierId ?? null, line.customerId ?? null);
  }
  return entryId;
}

export type NewAccount = { code: string; name: string; type: AccountType };
export type AccountChanges = { code?: string; name?: string };

const ACCOUNT_TYPES: readonly AccountType[] = ["asset", "liability", "equity", "income", "expense"];

function requireText(value: string, code: "account_code_required" | "account_name_required"): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new BusinessError(code, `${code === "account_code_required" ? "Code" : "Name"} is required`);
  return trimmed;
}

function assertCodeFree(db: Database.Database, code: string, exceptId?: number): void {
  const taken = db.prepare("SELECT id FROM accounts WHERE code = ?").get(code) as { id: number } | undefined;
  if (taken && taken.id !== exceptId) throw new BusinessError("account_code_taken", `Code ${code} is already used`);
}

function findAccount(db: Database.Database, id: number): Account {
  const row = db.prepare("SELECT id, code, name, type, role, active FROM accounts WHERE id = ?").get(id) as
    | AccountRow
    | undefined;
  if (!row) throw new BusinessError("account_not_found", `No account with id ${id}`);
  return toAccount(row);
}

function assertNotSystem(account: Account): void {
  if (account.role !== null) {
    throw new BusinessError("account_is_system", `Account ${account.code} is posted to automatically by the app`);
  }
}

export function addAccount(db: Database.Database, input: NewAccount): number {
  const code = requireText(input.code, "account_code_required");
  const name = requireText(input.name, "account_name_required");
  if (!ACCOUNT_TYPES.includes(input.type)) throw new BusinessError("account_type_invalid", `Unknown type ${input.type}`);
  assertCodeFree(db, code);
  return Number(db.prepare("INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)").run(code, name, input.type).lastInsertRowid);
}

export function updateAccount(db: Database.Database, id: number, changes: AccountChanges): void {
  const account = findAccount(db, id);
  const code = changes.code === undefined ? account.code : requireText(changes.code, "account_code_required");
  const name = changes.name === undefined ? account.name : requireText(changes.name, "account_name_required");
  assertCodeFree(db, code, id);
  db.prepare("UPDATE accounts SET code = ?, name = ? WHERE id = ?").run(code, name, id);
}

export function setAccountActive(db: Database.Database, id: number, active: boolean): void {
  const account = findAccount(db, id);
  if (!active) assertNotSystem(account);
  db.prepare("UPDATE accounts SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function deleteAccount(db: Database.Database, id: number): void {
  const account = findAccount(db, id);
  assertNotSystem(account);
  if (db.prepare("SELECT 1 FROM ledger_lines WHERE account_id = ? LIMIT 1").get(id)) {
    throw new BusinessError("account_has_postings", `Account ${account.code} has postings; deactivate it instead`);
  }
  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
}

/**
 * Posts the balances a shop brings in when it starts using the app. Whatever
 * the lines leave unbalanced goes to the opening balances equity account.
 */
export function postOpeningBalances(db: Database.Database, date: IsoDate, lines: JournalLine[]): number {
  const opening = db.prepare("SELECT id FROM accounts WHERE role = 'opening_balances'").get() as { id: number } | undefined;
  if (!opening) throw new BusinessError("account_not_found", "The opening balances account is missing");
  const difference = lines.reduce((t, l) => t + (l.debit ?? 0) - (l.credit ?? 0), 0);
  const balancing: JournalLine[] =
    difference === 0 ? [] : [difference > 0 ? { accountId: opening.id, credit: difference } : { accountId: opening.id, debit: -difference }];
  return postJournalEntry(db, { date, memo: "أرصدة افتتاحية", lines: [...lines, ...balancing] }, "opening_balances");
}
