import type Database from "better-sqlite3";
import { toEgp } from "./currency";
import { assertIsoDate } from "./dates";
import { BusinessError } from "./errors";
import type { Quantity } from "./items";
import { type IsoDate, type JournalLine, type Piastres, postJournalEntry } from "./ledger";
import { assertPostable, findSupplier } from "./purchases";
import { nextNumber } from "./shares";
import { accountByRole, insertMovement } from "./stock";

export type ShipmentCostKind = "customs_duty" | "freight" | "clearance" | "insurance" | "other";
export const SHIPMENT_COST_KINDS: readonly ShipmentCostKind[] = ["customs_duty", "freight", "clearance", "insurance", "other"];
/** How the shipment's costs are shared over its item lines. */
export type SpreadBy = "value" | "quantity";

export type ShipmentCostInput = {
  kind: ShipmentCostKind;
  /** The supplier billing this cost (customs, the shipping line, the clearing agent), in EGP. */
  payeeId: number;
  /** The cost in piastres, without VAT. */
  amount: Piastres;
  /** VAT paid on it (customs VAT on the shipment, or VAT on the agent's invoice): input VAT, not cost. */
  vat: Piastres;
};
export type ImportShipmentInput = {
  date: IsoDate;
  /** The bill of lading or customs declaration number. */
  reference: string;
  purchaseInvoiceIds: number[];
  spreadBy: SpreadBy;
  costs: ShipmentCostInput[];
};
export type ShipmentLine = {
  itemId: number;
  nameAr: string;
  /** In thousandths of the item's base unit. */
  quantity: Quantity;
  /** The goods' cost in EGP, as the purchase invoice put it into stock. */
  goods: Piastres;
  allocated: Piastres;
  /** Goods plus allocated costs, per one base unit. */
  landedUnitCost: Piastres;
  toCostOfSales: Piastres;
};
export type ImportShipment = {
  id: number;
  number: number;
  date: IsoDate;
  reference: string;
  spreadBy: SpreadBy;
  purchaseInvoiceIds: number[];
  costLines: (ShipmentCostInput & { payee: string })[];
  /** The goods in EGP, the costs spread over them (without VAT), and the VAT paid on the costs. */
  goods: Piastres;
  costs: Piastres;
  vat: Piastres;
  lines: ShipmentLine[];
};

const ONE_UNIT = 1000;

type BoughtLine = { id: number; itemId: number; warehouseId: number; quantity: number; size: number; net: number; rate: number };

/**
 * Shares `total` over `weights` in proportion, each rounded half-up; whatever rounding leaves
 * over (or takes too much) goes to the line with the largest weight, so the parts add up exactly.
 */
function spread(total: Piastres, weights: number[]): Piastres[] {
  const sum = weights.reduce((t, w) => t + w, 0);
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const parts = weights.map((w) => Math.round((total * w) / sum));
  const largest = weights.indexOf(Math.max(...weights));
  parts[largest]! += total - parts.reduce((t, p) => t + p, 0);
  return parts;
}

/**
 * Posts an import shipment: its costs spread over the items of its purchase invoices.
 * Dr Stock with the costs of units still held (raising their average cost), Dr Cost of
 * sales with the share of units already sold, Dr Input VAT, Cr each payee.
 */
export function postImportShipment(db: Database.Database, input: ImportShipmentInput, userId: number): number {
  assertIsoDate(input.date);
  if (input.purchaseInvoiceIds.length === 0) throw new BusinessError("shipment_needs_invoices", "A shipment needs at least one purchase invoice");
  if (input.costs.length === 0) throw new BusinessError("shipment_needs_costs", "A shipment needs at least one cost");
  if (input.spreadBy !== "value" && input.spreadBy !== "quantity") throw new BusinessError("spread_invalid", `Unknown spread ${String(input.spreadBy)}`);

  const payees = input.costs.map((c) => {
    if (!SHIPMENT_COST_KINDS.includes(c.kind)) throw new BusinessError("cost_kind_invalid", `Unknown cost ${String(c.kind)}`);
    for (const amount of [c.amount, c.vat]) {
      if (!Number.isSafeInteger(amount) || amount < 0) throw new BusinessError("amount_invalid", `Amount ${amount} is not whole piastres`);
    }
    const payee = findSupplier(db, c.payeeId);
    assertPostable(payee);
    if (payee.currency !== "EGP") throw new BusinessError("payee_not_egp", `${payee.name} bills in ${payee.currency}; shipment costs are in EGP`);
    return payee;
  });
  const total = input.costs.reduce((t, c) => t + c.amount, 0);
  const vat = input.costs.reduce((t, c) => t + c.vat, 0);
  if (total + vat === 0) throw new BusinessError("amount_invalid", "The shipment's costs are zero");

  const linesOf = db.prepare(
    `SELECT l.id, l.item_id AS itemId, p.warehouse_id AS warehouseId, l.quantity, COALESCE(u.size, 1000) AS size, l.net, p.rate
       FROM purchase_invoice_lines l JOIN purchase_invoices p ON p.id = l.invoice_id
       LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
      WHERE l.invoice_id = ? ORDER BY l.id`,
  );
  const bought: BoughtLine[] = [];
  for (const id of new Set(input.purchaseInvoiceIds)) {
    if (!db.prepare("SELECT 1 FROM purchase_invoices WHERE id = ?").get(id)) throw new BusinessError("invoice_not_found", `No purchase invoice with id ${id}`);
    if (db.prepare("SELECT 1 FROM import_shipment_invoices WHERE purchase_invoice_id = ?").get(id)) {
      throw new BusinessError("invoice_in_shipment", `Purchase invoice ${id} is already in a shipment`);
    }
    bought.push(...(linesOf.all(id) as BoughtLine[]));
  }
  const lines = bought.map((l) => ({ ...l, base: Math.round((l.quantity * l.size) / ONE_UNIT), goods: toEgp(l.net, l.rate) }));
  const allocated = spread(total, lines.map((l) => (input.spreadBy === "value" ? l.goods : l.base)));

  // Units of an item already gone since it arrived take their share to cost of sales.
  const heldOf = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_movements WHERE item_id = ?");
  const held = new Map<number, number>();
  const split = lines.map((l, i) => {
    const left = held.get(l.itemId) ?? Math.max(0, (heldOf.get(l.itemId) as { q: number }).q);
    const inStock = Math.min(left, l.base);
    held.set(l.itemId, left - inStock);
    const toStock = inStock === l.base ? allocated[i]! : Math.round((allocated[i]! * inStock) / l.base);
    return { toStock, toCostOfSales: allocated[i]! - toStock };
  });
  const toStock = split.reduce((t, s) => t + s.toStock, 0);
  const toCostOfSales = split.reduce((t, s) => t + s.toCostOfSales, 0);

  const number = nextNumber(db, "import_shipments");
  const reference = input.reference.trim();
  const journal: JournalLine[] = [];
  if (toStock > 0) journal.push({ accountId: accountByRole(db, "stock"), debit: toStock });
  if (toCostOfSales > 0) journal.push({ accountId: accountByRole(db, "cost_of_goods_sold"), debit: toCostOfSales });
  if (vat > 0) journal.push({ accountId: accountByRole(db, "input_vat"), debit: vat });
  input.costs.forEach((c, i) => {
    if (c.amount + c.vat > 0) journal.push({ accountId: accountByRole(db, "payables"), credit: c.amount + c.vat, supplierId: payees[i]!.id });
  });
  const entryId = postJournalEntry(
    db,
    { date: input.date, memo: `شحنة استيراد رقم ${number}${reference ? ` - ${reference}` : ""}`, lines: journal },
    "import_shipment",
  );
  const id = Number(
    db
      .prepare("INSERT INTO import_shipments (number, date, reference, spread_by, entry_id, user_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(number, input.date, reference, input.spreadBy, entryId, userId).lastInsertRowid,
  );
  const linkInvoice = db.prepare("INSERT INTO import_shipment_invoices (shipment_id, purchase_invoice_id) VALUES (?, ?)");
  for (const invoiceId of new Set(input.purchaseInvoiceIds)) linkInvoice.run(id, invoiceId);
  const insertCost = db.prepare("INSERT INTO import_shipment_costs (shipment_id, kind, supplier_id, amount, vat) VALUES (?, ?, ?, ?, ?)");
  for (const c of input.costs) insertCost.run(id, c.kind, c.payeeId, c.amount, c.vat);
  const insertLine = db.prepare(
    "INSERT INTO import_shipment_lines (shipment_id, purchase_line_id, allocated, to_stock, to_cost_of_sales) VALUES (?, ?, ?, ?, ?)",
  );
  lines.forEach((l, i) => {
    insertLine.run(id, l.id, allocated[i]!, split[i]!.toStock, split[i]!.toCostOfSales);
    // A value-only movement: no units move, the units held carry the cost.
    if (split[i]!.toStock !== 0) {
      insertMovement(db, { date: input.date, itemId: l.itemId, warehouseId: l.warehouseId, quantity: 0, value: split[i]!.toStock, source: "import_shipment", sourceId: id });
    }
  });
  return id;
}

/** Import shipments, newest first, with each item's landed unit cost. */
export function listImportShipments(db: Database.Database): ImportShipment[] {
  const rows = db
    .prepare("SELECT id, number, date, reference, spread_by AS spreadBy FROM import_shipments ORDER BY number DESC")
    .all() as Pick<ImportShipment, "id" | "number" | "date" | "reference" | "spreadBy">[];
  const invoices = db.prepare("SELECT purchase_invoice_id AS id FROM import_shipment_invoices WHERE shipment_id = ? ORDER BY purchase_invoice_id");
  const costs = db.prepare(
    `SELECT c.kind, c.supplier_id AS payeeId, s.name AS payee, c.amount, c.vat
       FROM import_shipment_costs c JOIN suppliers s ON s.id = c.supplier_id WHERE c.shipment_id = ? ORDER BY c.id`,
  );
  const lines = db.prepare(
    `SELECT l.item_id AS itemId, i.name_ar AS nameAr, l.quantity, COALESCE(u.size, 1000) AS size, l.net, p.rate,
            x.allocated, x.to_cost_of_sales AS toCostOfSales
       FROM import_shipment_lines x JOIN purchase_invoice_lines l ON l.id = x.purchase_line_id
       JOIN purchase_invoices p ON p.id = l.invoice_id JOIN items i ON i.id = l.item_id
       LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
      WHERE x.shipment_id = ? ORDER BY x.id`,
  );
  return rows.map((r) => {
    const cs = costs.all(r.id) as ImportShipment["costLines"];
    const ls = (
      lines.all(r.id) as { itemId: number; nameAr: string; quantity: number; size: number; net: number; rate: number; allocated: number; toCostOfSales: number }[]
    ).map((l) => {
      const quantity = Math.round((l.quantity * l.size) / ONE_UNIT);
      const goods = toEgp(l.net, l.rate);
      return {
        itemId: l.itemId,
        nameAr: l.nameAr,
        quantity,
        goods,
        allocated: l.allocated,
        landedUnitCost: quantity === 0 ? 0 : Math.round(((goods + l.allocated) * ONE_UNIT) / quantity),
        toCostOfSales: l.toCostOfSales,
      };
    });
    return {
      ...r,
      purchaseInvoiceIds: (invoices.all(r.id) as { id: number }[]).map((x) => x.id),
      costLines: cs,
      goods: ls.reduce((t, l) => t + l.goods, 0),
      costs: cs.reduce((t, c) => t + c.amount, 0),
      vat: cs.reduce((t, c) => t + c.vat, 0),
      lines: ls,
    };
  });
}
