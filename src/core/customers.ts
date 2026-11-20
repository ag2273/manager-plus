import type Database from "better-sqlite3";
import { BusinessError } from "./errors";
import type { Piastres } from "./ledger";

export type Customer = { id: number; name: string; phone: string; taxRegistrationNumber: string; active: boolean };
export type CustomerInput = { name: string; phone: string; taxRegistrationNumber: string };
export type CustomerChanges = Partial<CustomerInput>;

type CustomerRow = { id: number; name: string; phone: string; tax_registration_number: string; active: number };
const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  taxRegistrationNumber: r.tax_registration_number,
  active: r.active === 1,
});

export function listCustomers(db: Database.Database): Customer[] {
  return (
    db.prepare("SELECT id, name, phone, tax_registration_number, active FROM customers ORDER BY name").all() as CustomerRow[]
  ).map(toCustomer);
}

export function findCustomer(db: Database.Database, id: number): Customer {
  const row = db.prepare("SELECT id, name, phone, tax_registration_number, active FROM customers WHERE id = ?").get(id) as
    | CustomerRow
    | undefined;
  if (!row) throw new BusinessError("customer_not_found", `No customer with id ${id}`);
  return toCustomer(row);
}

function cleanCustomer(input: CustomerInput): CustomerInput {
  const name = input.name.trim();
  if (name === "") throw new BusinessError("customer_name_required", "A customer needs a name");
  const taxRegistrationNumber = input.taxRegistrationNumber.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (taxRegistrationNumber !== "" && !/^\d{9}$/.test(taxRegistrationNumber)) {
    throw new BusinessError("tax_registration_number_invalid", "Tax registration number must be 9 digits");
  }
  return { name, phone: input.phone.trim(), taxRegistrationNumber };
}

export function addCustomer(db: Database.Database, input: CustomerInput): number {
  const s = cleanCustomer(input);
  return Number(
    db
      .prepare("INSERT INTO customers (name, phone, tax_registration_number) VALUES (?, ?, ?)")
      .run(s.name, s.phone, s.taxRegistrationNumber).lastInsertRowid,
  );
}

export function updateCustomer(db: Database.Database, id: number, changes: CustomerChanges): void {
  const current = findCustomer(db, id);
  const s = cleanCustomer({ ...current, ...changes });
  db.prepare("UPDATE customers SET name = ?, phone = ?, tax_registration_number = ? WHERE id = ?").run(
    s.name,
    s.phone,
    s.taxRegistrationNumber,
    id,
  );
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

