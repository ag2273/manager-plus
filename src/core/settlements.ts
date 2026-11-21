import type Database from "better-sqlite3";
import { findCustomer } from "./customers";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { type Currency, ONE, type Rate, assertRate, toEgp } from "./currency";
import { documentRate, findSupplier } from "./purchases";
import { nextNumber } from "./shares";
import { accountByRole } from "./stock";

/** Customers owe the business (their documents are debits); the business owes suppliers (credits). */
export type PartyKind = "customer" | "supplier";
export type PaymentInput = {
  date: IsoDate;
  /** The customer paying, or the supplier being paid. */
  partyId: number;
  /** The cash, bank or wallet account the money goes into or comes out of. */
  accountId: number;
  /** In the party's currency: piastres, or the minor units of a foreign supplier's currency. */
  amount: Piastres;
  /** EGP per unit of a foreign supplier's currency, in millionths; left out for EGP. */
  rate?: Rate;
  reference: string;
  /** Documents this payment settles, by their journal entry (see `openDocuments`). Any rest settles the oldest first. */
  allocations?: { entryId: number; amount: Piastres }[];
};
export type PaymentResult = { id: number; number: number };
/** A document that raised what a party owes (an invoice, a credit sale, an opening balance). */
export type OpenDocument = { entryId: number; date: IsoDate; memo: string; amount: Piastres; open: Piastres };
export type StatementLine = { date: IsoDate; entryId: number; memo: string; debit: Piastres; credit: Piastres; balance: Piastres };
export type Statement = { partyId: number; name: string; currency: Currency; from: IsoDate; to: IsoDate; opening: Piastres; lines: StatementLine[]; closing: Piastres };
/** What a party owes by the age of the documents still open: 0–30, 31–60, 61–90, over 90 days. */
export type AgingRow = { partyId: number; name: string; buckets: [Piastres, Piastres, Piastres, Piastres]; unapplied: Piastres; balance: Piastres };
export type Aging = { asOf: IsoDate; rows: AgingRow[]; totals: AgingRow["buckets"]; unapplied: Piastres; balance: Piastres };

const COLUMN: Record<PartyKind, string> = { customer: "customer_id", supplier: "supplier_id" };
/** Money accounts a payment may use: the drawer, the main cash box, the bank, wallets, or any asset account without a role. */
const MONEY_ROLES = ["cash_drawer", "main_cash", "bank", "wallet"];

function partyName(db: Database.Database, kind: PartyKind, id: number): string {
  return kind === "customer" ? findCustomer(db, id).name : findSupplier(db, id).name;
}

/** A party line's debit and credit in the party's currency: a foreign supplier's lines carry it, all others are EGP. */
const DEBIT = "CASE WHEN l.debit > 0 THEN COALESCE(l.foreign_amount, l.debit) ELSE 0 END";
const CREDIT = "CASE WHEN l.credit > 0 THEN COALESCE(l.foreign_amount, l.credit) ELSE 0 END";

/**
 * Each journal entry touching the party, netted to the side that raises what is owed (+) or
 * settles it (−): `amount` in the party's currency, `egp` as it stands in the books.
 */
function partyEntries(db: Database.Database, kind: PartyKind, id: number, asOf: IsoDate) {
  const [raise, settle] = kind === "customer" ? ["debit", "credit"] : ["credit", "debit"];
  const [raiseForeign, settleForeign] = kind === "customer" ? [DEBIT, CREDIT] : [CREDIT, DEBIT];
  return db
    .prepare(
      `SELECT e.id AS entryId, e.date, e.memo, SUM(${raiseForeign}) - SUM(${settleForeign}) AS amount, SUM(l.${raise}) - SUM(l.${settle}) AS egp
         FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.${COLUMN[kind]} = ? AND e.date <= ?
        GROUP BY e.id ORDER BY e.date, e.id`,
    )
    .all(id, asOf) as { entryId: number; date: IsoDate; memo: string; amount: number; egp: Piastres }[];
}

/**
 * Which settling entry was meant for which document: payment allocations, notes and returns
 * against their invoice; `amount` in the party's currency, `egp` what it took off in the books.
 */
function links(db: Database.Database): { source: number; target: number; amount: number; egp: Piastres }[] {
  return db
    .prepare(
      `SELECT p.entry_id AS source, a.entry_id AS target, a.amount, COALESCE(a.egp_amount, a.amount) AS egp
         FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
       UNION ALL
       SELECT n.entry_id, s.entry_id, t.amount, t.amount
         FROM credit_notes n JOIN sales_invoices s ON s.id = n.invoice_id
         JOIN (SELECT note_id, SUM(net + vat) AS amount FROM credit_note_lines GROUP BY note_id) t ON t.note_id = n.id
       UNION ALL
       SELECT r.entry_id, s.entry_id, t.amount, t.amount
         FROM sales_returns r JOIN sales_receipts s ON s.id = r.receipt_id
         JOIN (SELECT return_id, SUM(amount) AS amount FROM sales_return_lines GROUP BY return_id) t ON t.return_id = r.id
        WHERE r.refund = 'account'
       UNION ALL
       SELECT n.entry_id, p.entry_id, (SELECT SUM(x.net + x.vat) FROM debit_note_lines x WHERE x.note_id = n.id),
              (SELECT SUM(x.debit) FROM ledger_lines x WHERE x.entry_id = n.entry_id AND x.supplier_id IS NOT NULL)
         FROM debit_notes n JOIN purchase_invoices p ON p.id = n.purchase_invoice_id`,
    )
    .all() as { source: number; target: number; amount: number; egp: Piastres }[];
}

/** The EGP part of `egp` that goes with `part` of `whole`, so that taking all of it leaves exactly nothing. */
const portion = (egp: Piastres, part: number, whole: number) => (part === whole ? egp : Math.round((egp * part) / whole));

/**
 * Matches what settled the party's account against what raised it: first as linked
 * (allocations, notes, returns), then the rest against the oldest documents first.
 * `fifo` false stops after the links, which is what is still free to allocate.
 */
function match(db: Database.Database, kind: PartyKind, id: number, asOf: IsoDate, fifo: boolean) {
  const entries = partyEntries(db, kind, id, asOf);
  const documents = entries.filter((e) => e.amount > 0).map((e) => ({ ...e, open: e.amount, openEgp: e.egp }));
  const credits = new Map(entries.filter((e) => e.amount < 0).map((e) => [e.entryId, { remaining: -e.amount }]));
  const byEntry = new Map(documents.map((d) => [d.entryId, d]));
  for (const link of links(db)) {
    const credit = credits.get(link.source);
    const document = byEntry.get(link.target);
    if (!credit || !document) continue;
    const applied = Math.min(link.amount, credit.remaining, document.open);
    if (applied <= 0) continue;
    credit.remaining -= applied;
    document.openEgp -= applied === document.open ? document.openEgp : portion(link.egp, applied, link.amount);
    document.open -= applied;
  }
  let unapplied = [...credits.values()].reduce((t, c) => t + c.remaining, 0);
  if (fifo) {
    for (const document of documents) {
      const applied = Math.min(unapplied, document.open);
      document.openEgp -= portion(document.openEgp, applied, document.open);
      document.open -= applied;
      unapplied -= applied;
    }
  }
  return { documents, unapplied, balanceEgp: entries.reduce((t, e) => t + e.egp, 0) };
}

const publicDocument = (d: OpenDocument): OpenDocument => ({ entryId: d.entryId, date: d.date, memo: d.memo, amount: d.amount, open: d.open });

/** The party's documents that still have something not yet allocated, oldest first, in the party's currency. */
export function openDocuments(db: Database.Database, kind: PartyKind, id: number): OpenDocument[] {
  partyName(db, kind, id);
  return open(db, kind, id).map(publicDocument);
}

function open(db: Database.Database, kind: PartyKind, id: number) {
  return match(db, kind, id, "9999-12-31", false).documents.filter((d) => d.open > 0);
}

/**
 * Records money from a customer (Dr the money account, Cr Receivables) or to a
 * supplier (Dr Payables, Cr the money account), both tagged with the party, with an
 * optional split over the documents it settles.
 */
export function recordPayment(db: Database.Database, kind: PartyKind, input: PaymentInput, userId: number): PaymentResult {
  assertIsoDate(input.date);
  const name = partyName(db, kind, input.partyId);
  const currency: Currency = kind === "supplier" ? findSupplier(db, input.partyId).currency : "EGP";
  const rate = kind === "supplier" ? documentRate(findSupplier(db, input.partyId), input.rate) : (input.rate ?? ONE);
  assertRate(currency, rate);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new BusinessError("amount_invalid", `Amount ${input.amount} is not a positive whole number of piastres`);
  }
  const account = db.prepare("SELECT id, type, role, active FROM accounts WHERE id = ?").get(input.accountId) as
    | { id: number; type: string; role: string | null; active: number }
    | undefined;
  if (!account || account.active !== 1 || account.type !== "asset" || (account.role !== null && !MONEY_ROLES.includes(account.role))) {
    throw new BusinessError("account_not_allowed", `Account ${input.accountId} is not a cash, bank or wallet account`);
  }

  const documents = open(db, kind, input.partyId);
  const byEntry = new Map(documents.map((d) => [d.entryId, d]));
  const allocations: { entryId: number; amount: number; egp: Piastres }[] = [];
  /** Takes part of a document's open amount, with what that part stands at in EGP at the document's own rate. */
  const allocate = (entryId: number, amount: number) => {
    const d = byEntry.get(entryId);
    const free = d?.open ?? 0;
    if (!d || !Number.isSafeInteger(amount) || amount <= 0 || amount > free) {
      throw new BusinessError("allocation_invalid", `Entry ${entryId} has ${free} open, not ${amount}`);
    }
    const egp = portion(d.openEgp, amount, d.open);
    d.open -= amount;
    d.openEgp -= egp;
    allocations.push({ entryId, amount, egp });
  };
  for (const a of input.allocations ?? []) allocate(a.entryId, a.amount);
  let allocated = allocations.reduce((t, a) => t + a.amount, 0);
  if (allocated > input.amount) throw new BusinessError("allocation_invalid", `Allocated ${allocated} of a payment of ${input.amount}`);
  // A foreign payment settles the oldest invoices with what is left, so that each part is taken at its invoice's rate.
  if (currency !== "EGP") {
    for (const d of documents) {
      const amount = Math.min(input.amount - allocated, d.open);
      if (amount <= 0) continue;
      allocate(d.entryId, amount);
      allocated += amount;
    }
  }
  // What the payment takes off the books: allocated parts at their documents' rates, any advance at the payment's rate.
  const paidEgp = toEgp(input.amount, rate);
  const allocatedAtPaymentRate = toEgp(allocated, rate);
  const carrying = allocations.reduce((t, a) => t + a.egp, 0);
  const settledEgp = carrying + (paidEgp - allocatedAtPaymentRate);
  const difference = allocatedAtPaymentRate - carrying;

  const number = nextNumber(db, "payments", "kind = ?", kind);
  const party = kind === "customer" ? { customerId: input.partyId } : { supplierId: input.partyId };
  const journal: JournalLine[] =
    kind === "customer"
      ? [
          { accountId: account.id, debit: input.amount },
          { accountId: accountByRole(db, "receivables"), credit: input.amount, ...party },
        ]
      : [
          { accountId: accountByRole(db, "payables"), debit: settledEgp, ...party, ...(currency === "EGP" ? {} : { foreign: input.amount }) },
          ...(difference > 0 ? [{ accountId: accountByRole(db, "exchange_loss"), debit: difference }] : []),
          ...(difference < 0 ? [{ accountId: accountByRole(db, "exchange_gain"), credit: -difference }] : []),
          { accountId: account.id, credit: paidEgp },
        ];
  const memo = kind === "customer" ? `سند قبض رقم ${number} من ${name}` : `سند صرف رقم ${number} إلى ${name}${currency === "EGP" ? "" : ` (${currency})`}`;
  const entryId = postJournalEntry(db, { date: input.date, memo, lines: journal }, `${kind}_payment`);
  const id = Number(
    db
      .prepare(
        `INSERT INTO payments (kind, number, date, customer_id, supplier_id, account_id, amount, reference, entry_id, user_id, currency, rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kind,
        number,
        input.date,
        kind === "customer" ? input.partyId : null,
        kind === "supplier" ? input.partyId : null,
        account.id,
        input.amount,
        input.reference.trim(),
        entryId,
        userId,
        currency,
        rate,
      ).lastInsertRowid,
  );
  const insert = db.prepare("INSERT INTO payment_allocations (payment_id, entry_id, amount, egp_amount) VALUES (?, ?, ?, ?)");
  for (const a of allocations) insert.run(id, a.entryId, a.amount, a.egp);
  return { id, number };
}

/** Every posting to the party's account between two dates, with the balance before, after each line, and at the end. */
export function statement(db: Database.Database, kind: PartyKind, id: number, from: IsoDate, to: IsoDate): Statement {
  assertIsoDate(from);
  assertIsoDate(to);
  if (from > to) throw new BusinessError("date_range_invalid", `${from} is after ${to}`);
  const name = partyName(db, kind, id);
  const currency: Currency = kind === "supplier" ? findSupplier(db, id).currency : "EGP";
  const sign = kind === "customer" ? 1 : -1;
  const column = COLUMN[kind];
  const before = db
    .prepare(
      `SELECT COALESCE(SUM(${DEBIT}) - SUM(${CREDIT}), 0) AS owed
         FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.${column} = ? AND e.date < ?`,
    )
    .get(id, from) as { owed: number };
  const rows = db
    .prepare(
      `SELECT e.date, e.id AS entryId, e.memo, SUM(${DEBIT}) AS debit, SUM(${CREDIT}) AS credit
         FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.${column} = ? AND e.date BETWEEN ? AND ?
        GROUP BY e.id ORDER BY e.date, e.id`,
    )
    .all(id, from, to) as Omit<StatementLine, "balance">[];
  const opening = sign * before.owed + 0; // never -0
  let balance = opening;
  const lines = rows.map((r) => {
    balance += sign * (r.debit - r.credit);
    return { ...r, balance };
  });
  return { partyId: id, name, currency, from, to, opening, lines, closing: balance };
}

const DAY_MS = 86_400_000;
const bucketOf = (age: number) => (age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3);

/**
 * Aged receivables or payables: every party with something owed either way, by the age of their
 * open documents, in EGP as the books carry them (a foreign supplier's documents at their own rates).
 */
export function aging(db: Database.Database, kind: PartyKind, asOf: IsoDate): Aging {
  assertIsoDate(asOf);
  const parties = db
    .prepare(`SELECT DISTINCT p.id, p.name FROM ${kind}s p JOIN ledger_lines l ON l.${COLUMN[kind]} = p.id ORDER BY p.name`)
    .all() as { id: number; name: string }[];
  const end = Date.parse(asOf);
  const rows: AgingRow[] = [];
  for (const party of parties) {
    const { documents, balanceEgp: balance } = match(db, kind, party.id, asOf, true);
    const buckets: AgingRow["buckets"] = [0, 0, 0, 0];
    for (const d of documents) buckets[bucketOf(Math.round((end - Date.parse(d.date)) / DAY_MS))] += d.openEgp;
    const unapplied = buckets.reduce((t, b) => t + b, 0) - balance;
    if (balance !== 0 || unapplied !== 0) rows.push({ partyId: party.id, name: party.name, buckets, unapplied, balance });
  }
  const totals: AgingRow["buckets"] = [0, 1, 2, 3].map((i) => rows.reduce((t, r) => t + r.buckets[i]!, 0)) as AgingRow["buckets"];
  return {
    asOf,
    rows,
    totals,
    unapplied: rows.reduce((t, r) => t + r.unapplied, 0),
    balance: rows.reduce((t, r) => t + r.balance, 0),
  };
}
