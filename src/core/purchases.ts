import type Database from "better-sqlite3";
import { type Currency, CURRENCIES as CURRENCY_TABLE, ONE, type Rate, assertRate, toEgp } from "./currency";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import { type BasisPoints, type Quantity, vatRate } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { receiveSerials, serialsFor } from "./serials";
import { type SerialLine, type UnitLine, accountByRole, activeWarehouse, assertQuantity, insertMovement, toBaseQuantity } from "./stock";

export type { Currency, Rate } from "./currency";
/** The currencies a supplier can bill in, by ISO code. */
export const CURRENCIES: readonly Currency[] = CURRENCY_TABLE.map((c) => c.code);
export type Supplier = { id: number; name: string; phone: string; taxRegistrationNumber: string; currency: Currency; active: boolean };
export type SupplierInput = { name: string; phone: string; taxRegistrationNumber: string; currency?: Currency };
export type SupplierChanges = Partial<SupplierInput>;

/** A purchase line: quantity in thousandths of the chosen unit, price per one of that unit, VAT-exclusive. */
export type PurchaseLineInput = UnitLine & SerialLine & { unitPrice: Piastres };
export type PurchaseInvoiceInput = {
  date: IsoDate;
  supplierId: number;
  warehouseId: number;
  /** The supplier's own invoice number. */
  reference: string;
  /** EGP per unit of the supplier's currency, in millionths; required when they bill in another currency. */
  rate?: Rate;
  /** In the supplier's currency: prices and amounts in its minor units. */
  lines: PurchaseLineInput[];
};
export type PurchaseLine = PurchaseLineInput & { net: Piastres; vatRate: BasisPoints; vat: Piastres };
/** A posted purchase line, with how much of it already went back to the supplier. */
export type PostedPurchaseLine = PurchaseLine & { lineId: number; nameAr: string; returned: Quantity };
export type PurchaseInvoice = {
  id: number;
  date: IsoDate;
  supplierId: number;
  warehouseId: number;
  reference: string;
  currency: Currency;
  rate: Rate;
  /** In the invoice's currency. */
  net: Piastres;
  vat: Piastres;
  total: Piastres;
  /** What the invoice put on the supplier's account in EGP. */
  totalEgp: Piastres;
  postedBy: string;
  lines: PostedPurchaseLine[];
};

const ONE_UNIT = 1000;
const WHOLE = 10_000;

type SupplierRow = { id: number; name: string; phone: string; tax_registration_number: string; currency: Currency; active: number };
const SUPPLIER_COLUMNS = "id, name, phone, tax_registration_number, currency, active";
const toSupplier = (r: SupplierRow): Supplier => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  taxRegistrationNumber: r.tax_registration_number,
  currency: r.currency,
  active: r.active === 1,
});

export function listSuppliers(db: Database.Database): Supplier[] {
  return (
    db.prepare(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers ORDER BY name`).all() as SupplierRow[]
  ).map(toSupplier);
}

export function findSupplier(db: Database.Database, id: number): Supplier {
  const row = db.prepare(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE id = ?`).get(id) as
    | SupplierRow
    | undefined;
  if (!row) throw new BusinessError("supplier_not_found", `No supplier with id ${id}`);
  return toSupplier(row);
}

function cleanSupplier(db: Database.Database, input: SupplierInput, exceptId: number | null): Required<SupplierInput> {
  const name = input.name.trim();
  if (name === "") throw new BusinessError("supplier_name_required", "A supplier needs a name");
  const owner = db.prepare("SELECT id FROM suppliers WHERE name = ?").get(name) as { id: number } | undefined;
  if (owner && owner.id !== exceptId) throw new BusinessError("supplier_name_taken", `A supplier called ${name} exists`);
  const taxRegistrationNumber = input.taxRegistrationNumber.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (taxRegistrationNumber !== "" && !/^\d{9}$/.test(taxRegistrationNumber)) {
    throw new BusinessError("tax_registration_number_invalid", "Tax registration number must be 9 digits");
  }
  const currency = input.currency ?? "EGP";
  if (!CURRENCIES.includes(currency)) throw new BusinessError("currency_invalid", `Unknown currency ${currency}`);
  return { name, phone: input.phone.trim(), taxRegistrationNumber, currency };
}

export function addSupplier(db: Database.Database, input: SupplierInput): number {
  const s = cleanSupplier(db, input, null);
  return Number(
    db
      .prepare("INSERT INTO suppliers (name, phone, tax_registration_number, currency) VALUES (?, ?, ?, ?)")
      .run(s.name, s.phone, s.taxRegistrationNumber, s.currency).lastInsertRowid,
  );
}

export function updateSupplier(db: Database.Database, id: number, changes: SupplierChanges): void {
  const current = findSupplier(db, id);
  const s = cleanSupplier(db, { ...current, ...changes }, id);
  if (s.currency !== current.currency && db.prepare("SELECT 1 FROM ledger_lines WHERE supplier_id = ? LIMIT 1").get(id)) {
    throw new BusinessError("supplier_currency_locked", `Supplier ${current.name} already has postings in ${current.currency}`);
  }
  db.prepare("UPDATE suppliers SET name = ?, phone = ?, tax_registration_number = ?, currency = ? WHERE id = ?").run(
    s.name,
    s.phone,
    s.taxRegistrationNumber,
    s.currency,
    id,
  );
}

export function setSupplierActive(db: Database.Database, id: number, active: boolean): void {
  findSupplier(db, id);
  db.prepare("UPDATE suppliers SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

/** What the business owes the supplier, from the payables lines in the ledger. */
export function supplierBalance(db: Database.Database, id: number): Piastres {
  findSupplier(db, id);
  const row = db
    .prepare("SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS owed FROM ledger_lines WHERE supplier_id = ?")
    .get(id) as { owed: number };
  return row.owed;
}

/** What the business owes the supplier in their own currency, and what that stands at in EGP in the books. */
export type SupplierAccount = { currency: Currency; owed: number; owedEgp: Piastres };

export function supplierAccount(db: Database.Database, id: number): SupplierAccount {
  const supplier = findSupplier(db, id);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN credit > 0 THEN COALESCE(foreign_amount, credit) ELSE -COALESCE(foreign_amount, debit) END), 0) AS owed,
              COALESCE(SUM(credit) - SUM(debit), 0) AS owedEgp
         FROM ledger_lines WHERE supplier_id = ?`,
    )
    .get(id) as { owed: number; owedEgp: number };
  return { currency: supplier.currency, owed: row.owed + 0, owedEgp: row.owedEgp + 0 };
}

/** A supplier that can take a new invoice, payment or note. */
export function assertPostable(supplier: Supplier): void {
  if (!supplier.active) throw new BusinessError("supplier_inactive", `Supplier ${supplier.name} is stopped`);
}

/** The rate a supplier's document posts at: the one typed for a foreign currency, none for EGP. */
export function documentRate(supplier: Supplier, rate: Rate | undefined): Rate {
  if (supplier.currency !== "EGP" && rate === undefined) {
    throw new BusinessError("rate_invalid", `Supplier ${supplier.name} bills in ${supplier.currency}; the document needs an exchange rate`);
  }
  const posted = rate ?? ONE;
  assertRate(supplier.currency, posted);
  return posted;
}

export function vatRegistered(db: Database.Database): boolean {
  return (db.prepare("SELECT vat_registered FROM business_settings WHERE id = 1").get() as { vat_registered: number })
    .vat_registered === 1;
}

/** Amounts in the invoice's currency, and the total in EGP at the invoice's rate. */
export type PricedPurchase = { lines: PurchaseLine[]; net: Piastres; vat: Piastres; total: Piastres; totalEgp: Piastres };
/** The currency an invoice is in and its rate; EGP at one when left out. */
export type PurchaseMoney = { currency: Currency; rate: Rate };

/**
 * Prices invoice lines without posting: net per line, and VAT rounded half-up on each line.
 * A foreign supplier charges no Egyptian VAT: VAT on imports is paid at customs (#31).
 */
export function pricePurchase(
  db: Database.Database,
  date: IsoDate,
  lines: PurchaseLineInput[],
  money: PurchaseMoney = { currency: "EGP", rate: ONE },
): PricedPurchase & { lines: (PurchaseLine & { baseQuantity: Quantity; netEgp: Piastres; vatEgp: Piastres })[]; netEgp: Piastres; vatEgp: Piastres } {
  assertIsoDate(date);
  assertRate(money.currency, money.rate);
  const registered = vatRegistered(db) && money.currency === "EGP";
  const taxCodeOf = db.prepare("SELECT tax_code_id AS id FROM items WHERE id = ?");
  const priced = lines.map((line) => {
    assertQuantity(line.quantity);
    if (!Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0) {
      throw new BusinessError("price_invalid", `Unit price ${line.unitPrice} is not whole piastres`);
    }
    const baseQuantity = toBaseQuantity(db, line);
    const taxCode = taxCodeOf.get(line.itemId) as { id: number };
    const net = Math.round((line.quantity * line.unitPrice) / ONE_UNIT);
    const rate = vatRate(db, taxCode.id, date, registered);
    const vat = Math.round((net * rate) / WHOLE);
    return { ...line, baseQuantity, net, vatRate: rate, vat, netEgp: toEgp(net, money.rate), vatEgp: toEgp(vat, money.rate) };
  });
  const sum = (pick: (l: (typeof priced)[number]) => number) => priced.reduce((t, l) => t + pick(l), 0);
  const net = sum((l) => l.net);
  const vat = sum((l) => l.vat);
  const netEgp = sum((l) => l.netEgp);
  const vatEgp = sum((l) => l.vatEgp);
  return { lines: priced, net, vat, total: net + vat, netEgp, vatEgp, totalEgp: netEgp + vatEgp };
}

/** Posts a supplier's invoice: stock in at net cost, input VAT, and the total owed to the supplier. */
export function postPurchaseInvoice(db: Database.Database, input: PurchaseInvoiceInput, userId: number): number {
  assertIsoDate(input.date);
  const supplier = findSupplier(db, input.supplierId);
  assertPostable(supplier);
  activeWarehouse(db, input.warehouseId);
  if (input.lines.length === 0) throw new BusinessError("invoice_needs_lines", "An invoice needs at least one line");
  const rate = documentRate(supplier, input.rate);
  const { lines, total, netEgp, vatEgp } = pricePurchase(db, input.date, input.lines, { currency: supplier.currency, rate });
  if (netEgp + vatEgp === 0) throw new BusinessError("invoice_total_zero", "The invoice total is zero");

  const journal: JournalLine[] = [];
  if (netEgp > 0) journal.push({ accountId: accountByRole(db, "stock"), debit: netEgp });
  if (vatEgp > 0) journal.push({ accountId: accountByRole(db, "input_vat"), debit: vatEgp });
  journal.push({
    accountId: accountByRole(db, "payables"),
    credit: netEgp + vatEgp,
    supplierId: supplier.id,
    ...(supplier.currency === "EGP" ? {} : { foreign: total }),
  });
  const reference = input.reference.trim();
  const entryId = postJournalEntry(
    db,
    { date: input.date, memo: `فاتورة مشتريات ${supplier.name}${reference ? ` رقم ${reference}` : ""}`, lines: journal },
    "purchase_invoice",
  );
  const id = Number(
    db
      .prepare(
        `INSERT INTO purchase_invoices (date, supplier_id, warehouse_id, reference, currency, rate, entry_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.date, supplier.id, input.warehouseId, reference, supplier.currency, rate, entryId, userId).lastInsertRowid,
  );
  const insertLine = db.prepare(
    `INSERT INTO purchase_invoice_lines (invoice_id, item_id, unit, quantity, unit_price, net, vat_rate, vat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let index = 0;
  for (const l of lines) {
    const lineId = Number(insertLine.run(id, l.itemId, l.unit, l.quantity, l.unitPrice, l.net, l.vatRate, l.vat).lastInsertRowid);
    const serials = serialsFor(db, l.itemId, l.baseQuantity, input.lines[index++]!.serials);
    receiveSerials(db, l.itemId, serials, { date: input.date, warehouseId: input.warehouseId, source: "purchase", sourceId: id, lineId });
    insertMovement(db, {
      date: input.date,
      itemId: l.itemId,
      warehouseId: input.warehouseId,
      quantity: l.baseQuantity,
      value: l.netEgp,
      source: "purchase",
      sourceId: id,
    });
  }
  return id;
}

type InvoiceRow = Omit<PurchaseInvoice, "net" | "vat" | "total" | "lines">;

/** Purchase invoices, newest first. */
export function listPurchaseInvoices(db: Database.Database): PurchaseInvoice[] {
  const invoices = db
    .prepare(
      `SELECT p.id, p.date, p.supplier_id AS supplierId, p.warehouse_id AS warehouseId, p.reference, p.currency, p.rate,
              (SELECT SUM(x.credit) FROM ledger_lines x WHERE x.entry_id = p.entry_id AND x.supplier_id IS NOT NULL) AS totalEgp,
              u.name AS postedBy
         FROM purchase_invoices p JOIN users u ON u.id = p.user_id
        ORDER BY p.date DESC, p.id DESC`,
    )
    .all() as InvoiceRow[];
  const lines = db.prepare(
    `SELECT l.id AS lineId, l.item_id AS itemId, i.name_ar AS nameAr, l.unit, l.quantity, l.unit_price AS unitPrice, l.net,
            l.vat_rate AS vatRate, l.vat,
            COALESCE((SELECT SUM(x.quantity) FROM debit_note_lines x WHERE x.purchase_line_id = l.id), 0) AS returned
       FROM purchase_invoice_lines l JOIN items i ON i.id = l.item_id WHERE l.invoice_id = ? ORDER BY l.id`,
  );
  return invoices.map((inv) => {
    const rows = lines.all(inv.id) as PostedPurchaseLine[];
    const net = rows.reduce((t, l) => t + l.net, 0);
    const vat = rows.reduce((t, l) => t + l.vat, 0);
    return { ...inv, net, vat, total: net + vat, lines: rows };
  });
}
