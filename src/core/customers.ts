import type Database from "better-sqlite3";
import { BusinessError } from "./errors";
import type { Piastres } from "./ledger";
import { type Credentials, authenticate, writeAudit } from "./users";
import { assertWithholdingCategory } from "./withholding";

/** Which shelf price a customer's quotations and invoices start from. */
export type PriceLevel = "retail" | "wholesale";
export const PRICE_LEVELS: readonly PriceLevel[] = ["retail", "wholesale"];
export type Customer = {
  id: number;
  name: string;
  phone: string;
  taxRegistrationNumber: string;
  address: string;
  priceLevel: PriceLevel;
  /** The most the customer may owe, in piastres; null is no limit. */
  creditLimit: Piastres | null;
  /** The withholding tax category the customer usually deducts under; null is none. */
  withholdingCategoryId: number | null;
  active: boolean;
};
export type CustomerInput = {
  name: string;
  phone: string;
  taxRegistrationNumber: string;
  address?: string;
  priceLevel?: PriceLevel;
  creditLimit?: Piastres | null;
  withholdingCategoryId?: number | null;
};
export type CustomerChanges = Partial<CustomerInput>;

type CustomerRow = {
  id: number;
  name: string;
  phone: string;
  tax_registration_number: string;
  address: string;
  price_level: PriceLevel;
  credit_limit: number | null;
  withholding_category_id: number | null;
  active: number;
};
const COLUMNS = "id, name, phone, tax_registration_number, address, price_level, credit_limit, withholding_category_id, active";
const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  taxRegistrationNumber: r.tax_registration_number,
  address: r.address,
  priceLevel: r.price_level,
  creditLimit: r.credit_limit,
  withholdingCategoryId: r.withholding_category_id,
  active: r.active === 1,
});

export function listCustomers(db: Database.Database): Customer[] {
  return (
    db.prepare(`SELECT ${COLUMNS} FROM customers ORDER BY name`).all() as CustomerRow[]
  ).map(toCustomer);
}

export function findCustomer(db: Database.Database, id: number): Customer {
  const row = db.prepare(`SELECT ${COLUMNS} FROM customers WHERE id = ?`).get(id) as
    | CustomerRow
    | undefined;
  if (!row) throw new BusinessError("customer_not_found", `No customer with id ${id}`);
  return toCustomer(row);
}

type CleanCustomer = Required<CustomerInput>;

function cleanCustomer(db: Database.Database, input: CustomerInput): CleanCustomer {
  const name = input.name.trim();
  if (name === "") throw new BusinessError("customer_name_required", "A customer needs a name");
  const taxRegistrationNumber = input.taxRegistrationNumber.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (taxRegistrationNumber !== "" && !/^\d{9}$/.test(taxRegistrationNumber)) {
    throw new BusinessError("tax_registration_number_invalid", "Tax registration number must be 9 digits");
  }
  const priceLevel = input.priceLevel ?? "retail";
  if (!PRICE_LEVELS.includes(priceLevel)) throw new BusinessError("price_level_invalid", `Unknown price level ${priceLevel}`);
  const creditLimit = input.creditLimit ?? null;
  if (creditLimit !== null && (!Number.isSafeInteger(creditLimit) || creditLimit < 0)) {
    throw new BusinessError("credit_limit_invalid", `Credit limit ${creditLimit} is not whole piastres`);
  }
  const withholdingCategoryId = input.withholdingCategoryId ?? null;
  assertWithholdingCategory(db, withholdingCategoryId);
  return { name, phone: input.phone.trim(), taxRegistrationNumber, address: (input.address ?? "").trim(), priceLevel, creditLimit, withholdingCategoryId };
}

export function addCustomer(db: Database.Database, input: CustomerInput): number {
  const s = cleanCustomer(db, input);
  return Number(
    db
      .prepare(
        "INSERT INTO customers (name, phone, tax_registration_number, address, price_level, credit_limit, withholding_category_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(s.name, s.phone, s.taxRegistrationNumber, s.address, s.priceLevel, s.creditLimit, s.withholdingCategoryId).lastInsertRowid,
  );
}

export function updateCustomer(db: Database.Database, id: number, changes: CustomerChanges): void {
  const current = findCustomer(db, id);
  const s = cleanCustomer(db, { ...current, ...changes });
  db.prepare(
    "UPDATE customers SET name = ?, phone = ?, tax_registration_number = ?, address = ?, price_level = ?, credit_limit = ?, withholding_category_id = ? WHERE id = ?",
  ).run(s.name, s.phone, s.taxRegistrationNumber, s.address, s.priceLevel, s.creditLimit, s.withholdingCategoryId, id);
}

export function setCustomerActive(db: Database.Database, id: number, active: boolean): void {
  findCustomer(db, id);
  db.prepare("UPDATE customers SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

/** What the customer owes the business, from the receivables lines in the ledger. */
export function customerBalance(db: Database.Database, id: number): Piastres {
  findCustomer(db, id);
  const row = db
    .prepare("SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS owed FROM ledger_lines WHERE customer_id = ?")
    .get(id) as { owed: number };
  return row.owed;
}


/** A manager's sign-in, given on a document that takes a customer past their credit limit. */
export type CreditApproval = Credentials;

/**
 * Refuses a document that would put `adding` more on the customer's account past their credit
 * limit, with the amount over, unless a manager signs in on it. The approval goes to the audit
 * log under the manager's name, with who asked and for which command.
 */
export function checkCreditLimit(
  db: Database.Database,
  customer: Customer,
  adding: Piastres,
  approval: CreditApproval | undefined,
  request: { document: string; requestedBy: string },
): void {
  if (customer.creditLimit === null || adding <= 0) return;
  const over = customerBalance(db, customer.id) + adding - customer.creditLimit;
  if (over <= 0) return;
  if (!approval) {
    throw new BusinessError("credit_limit_exceeded", `${customer.name} would go ${over} past their credit limit`, over);
  }
  const approver = authenticate(db, approval);
  if (approver.role !== "manager") throw new BusinessError("approval_not_manager", `${approver.name} is not a manager`);
  writeAudit(db, {
    userId: approver.id,
    action: "approveCreditLimit",
    entityId: customer.id,
    detail: JSON.stringify({ over, limit: customer.creditLimit, adding, ...request }),
  });
}
