import type Database from "better-sqlite3";
import { BusinessError } from "../errors";
import type { EtaTaxKind } from "./document";
import { etaReceipt, receiptQr } from "./receipt";

export type EtaReceiptSettings = {
  enabled: boolean;
  /** The POS as registered with the ETA. */
  posSerial: string;
  posOsVersion: string;
  posModel: string;
  posClientId: string;
  /** Whether the POS client secret and pre-shared key are saved; they never leave the PC that sealed them. */
  hasPosSecrets: boolean;
};
export type EtaReceiptSettingsInput = Omit<EtaReceiptSettings, "hasPosSecrets"> & {
  /** Sealed by the PC; left out to keep the saved ones. */
  posClientSecret?: string;
  presharedKey?: string;
};
export type EtaReceiptCredentials = {
  production: boolean;
  posSerial: string;
  posOsVersion: string;
  posModel: string;
  posClientId: string;
  posClientSecret: string;
  presharedKey: string;
};

export type EtaReceiptKind = "sale" | "return";
/** "" the receipt isn't an e-receipt; pending, failed, submitted, valid, invalid as for invoices. */
export type EtaReceiptStatus = "pending" | "failed" | "submitted" | "valid" | "invalid";
export type EtaReceiptRow = { kind: EtaReceiptKind; id: number; number: number; at: string; status: EtaReceiptStatus; uuid: string; error: string };
export type EtaReceiptOutcome = { status: EtaReceiptStatus; error?: string };

type Row = {
  enabled: number;
  receipts_enabled: number;
  environment: string;
  activity_code: string;
  governate: string;
  region_city: string;
  street: string;
  building_number: string;
  pos_serial: string;
  pos_os_version: string;
  pos_model: string;
  pos_client_id: string;
  pos_client_secret: string;
  pos_preshared_key: string;
  pos_last_uuid: string;
};
const row = (db: Database.Database) => db.prepare("SELECT * FROM eta_settings WHERE id = 1").get() as Row;
const receiptsOn = (r: Row) => r.enabled === 1 && r.receipts_enabled === 1;

export function etaReceiptSettings(db: Database.Database): EtaReceiptSettings {
  const r = row(db);
  return {
    enabled: r.receipts_enabled === 1,
    posSerial: r.pos_serial,
    posOsVersion: r.pos_os_version,
    posModel: r.pos_model,
    posClientId: r.pos_client_id,
    hasPosSecrets: r.pos_client_secret !== "" && r.pos_preshared_key !== "",
  };
}

export function setEtaReceiptSettings(db: Database.Database, input: EtaReceiptSettingsInput): void {
  const current = row(db);
  const clean = {
    posSerial: input.posSerial.trim(),
    posOsVersion: input.posOsVersion.trim(),
    posModel: input.posModel.trim(),
    posClientId: input.posClientId.trim(),
    posClientSecret: input.posClientSecret ?? current.pos_client_secret,
    presharedKey: input.presharedKey ?? current.pos_preshared_key,
  };
  if (input.enabled) {
    if (current.enabled !== 1) throw new BusinessError("eta_not_enabled", "Turn on e-invoicing first");
    if (Object.values(clean).some((v) => v === "")) throw new BusinessError("eta_settings_incomplete", "Fill in every POS registration detail");
  }
  db.prepare(
    `UPDATE eta_settings SET receipts_enabled = ?, pos_serial = ?, pos_os_version = ?, pos_model = ?, pos_client_id = ?,
            pos_client_secret = ?, pos_preshared_key = ? WHERE id = 1`,
  ).run(input.enabled ? 1 : 0, clean.posSerial, clean.posOsVersion, clean.posModel, clean.posClientId, clean.posClientSecret, clean.presharedKey);
}

export function etaReceiptCredentials(db: Database.Database): EtaReceiptCredentials {
  const r = row(db);
  if (!receiptsOn(r)) throw new BusinessError("eta_not_enabled", "E-receipts are off");
  return {
    production: r.environment === "production",
    posSerial: r.pos_serial,
    posOsVersion: r.pos_os_version,
    posModel: r.pos_model,
    posClientId: r.pos_client_id,
    posClientSecret: r.pos_client_secret,
    presharedKey: r.pos_preshared_key,
  };
}

const TABLE: Record<EtaReceiptKind, string> = { sale: "sales_receipts", return: "sales_returns" };

/**
 * Issues a just-posted till receipt or return as an e-receipt, when e-receipts are on: it gets its
 * UUID and its place in the chain now, so the printed receipt carries its QR code even offline,
 * and it waits to be sent. A return goes only when its sale was an e-receipt, since it must point to it.
 */
export function queueEtaReceipt(db: Database.Database, kind: EtaReceiptKind, id: number): void {
  if (!receiptsOn(row(db))) return;
  if (kind === "return") {
    const original = db.prepare("SELECT r.eta_status FROM sales_returns x JOIN sales_receipts r ON r.id = x.receipt_id WHERE x.id = ?").get(id) as {
      eta_status: string;
    };
    if (original.eta_status === "") return;
  }
  db.prepare(`UPDATE ${TABLE[kind]} SET eta_status = 'pending' WHERE id = ?`).run(id);
  issue(db, kind, id);
}

/** Gives a pending receipt its UUID. One that can't be issued yet (an item without a code) is failed, the sale still stands. */
function issue(db: Database.Database, kind: EtaReceiptKind, id: number): void {
  try {
    prepareEtaReceipt(db, kind, id);
  } catch (error) {
    if (!(error instanceof BusinessError)) throw error;
    recordEtaReceipt(db, kind, id, { status: "failed", error: error.detail ? `${error.code}: ${error.detail}` : error.code });
  }
}

const CHAIN = `
  SELECT 'sale' AS kind, id, number, at, eta_status AS status, eta_uuid AS uuid, eta_error AS error FROM sales_receipts WHERE eta_status <> ''
  UNION ALL
  SELECT 'return', id, number, at, eta_status, eta_uuid, eta_error FROM sales_returns WHERE eta_status <> ''`;

/** E-receipts in the order the POS issued them, oldest first; or only those in the given states. */
export function etaReceipts(db: Database.Database, statuses?: EtaReceiptStatus[]): EtaReceiptRow[] {
  const where = statuses ? ` WHERE status IN (${statuses.map(() => "?").join(", ")})` : "";
  return db.prepare(`SELECT * FROM (${CHAIN})${where} ORDER BY at, kind DESC, id`).all(...(statuses ?? [])) as EtaReceiptRow[];
}

type ReceiptLine = {
  nameAr: string;
  code: string | null;
  egsCode: string;
  unit: string;
  unitName: string;
  quantity: number;
  gross: number;
  net: number;
  vat: number;
  vatRate: number;
  taxKind: EtaTaxKind;
};

/**
 * The e-receipt for a queued receipt or return, with its UUID, chained to the one issued before it.
 * The UUID and the link are kept, so sending it again after a network failure sends the same receipt.
 */
export function prepareEtaReceipt(db: Database.Database, kind: EtaReceiptKind, id: number): { receipt: Record<string, unknown>; uuid: string } {
  const settings = row(db);
  const business = db.prepare("SELECT name, tax_registration_number AS rin FROM business_settings WHERE id = 1").get() as {
    name: string;
    rin: string;
  };
  const head = (
    kind === "sale"
      ? db.prepare("SELECT number, at, eta_uuid AS uuid, eta_previous_uuid AS previous, NULL AS original FROM sales_receipts WHERE id = ?").get(id)
      : db
          .prepare(
            `SELECT x.number, x.at, x.eta_uuid AS uuid, x.eta_previous_uuid AS previous, r.eta_uuid AS original
               FROM sales_returns x JOIN sales_receipts r ON r.id = x.receipt_id WHERE x.id = ?`,
          )
          .get(id)
  ) as { number: number; at: string; uuid: string; previous: string; original: string | null };
  const columns = `i.name_ar AS nameAr, i.code, i.egs_code AS egsCode, l.unit, u.name AS unitName, CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END AS taxKind, l.vat_rate AS vatRate`;
  const joins = `JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit`;
  const lines = (
    kind === "sale"
      ? db
          .prepare(`SELECT ${columns}, l.quantity, l.gross, l.net, l.vat FROM sales_receipt_lines l ${joins} WHERE l.receipt_id = ? ORDER BY l.id`)
          .all(id)
      : db
          .prepare(
            `SELECT ${columns}, x.quantity, x.amount AS gross, x.net, x.vat
               FROM sales_return_lines x JOIN sales_receipt_lines l ON l.id = x.receipt_line_id ${joins} WHERE x.return_id = ? ORDER BY x.id`,
          )
          .all(id)
  ) as ReceiptLine[];
  const uncoded = lines.find((l) => l.egsCode.trim() === "");
  if (uncoded)
    throw new BusinessError("eta_item_code_required", `${uncoded.nameAr} needs an EGS or GS1 code for e-receipts`, undefined, uncoded.nameAr);
  if (kind === "return" && !head.original) throw new BusinessError("eta_invoice_not_valid", "The original receipt was not sent");

  // The receipt before this one in the chain: the last one this POS issued.
  const previous = head.uuid !== "" ? head.previous : settings.pos_last_uuid;
  const method = kind === "return" ? "C" : paymentMethod(db, id);
  const built = etaReceipt({
    type: kind === "sale" ? "S" : "R",
    receiptNumber: `${kind === "sale" ? "S" : "R"}-${head.number}`,
    issuedAt: new Date(Math.floor(Date.parse(head.at) / 1000) * 1000),
    previousUuid: previous,
    ...(head.original ? { referenceUuid: head.original } : {}),
    seller: {
      rin: business.rin,
      name: business.name,
      activityCode: settings.activity_code,
      address: { governate: settings.governate, regionCity: settings.region_city, street: settings.street, buildingNumber: settings.building_number },
      deviceSerialNumber: settings.pos_serial,
    },
    paymentMethod: method,
    lines: lines.map((l) => ({
      description: l.unit === "pack" ? `${l.nameAr} (${l.unitName})` : l.nameAr,
      itemCode: l.egsCode.trim(),
      internalCode: l.code ?? "",
      quantity: l.quantity,
      gross: l.gross,
      net: l.net,
      vat: l.vat,
      vatRate: l.vatRate,
      taxKind: l.taxKind,
    })),
  });
  if (head.uuid === "") {
    db.prepare(`UPDATE ${TABLE[kind]} SET eta_uuid = ?, eta_previous_uuid = ? WHERE id = ?`).run(built.uuid, previous, id);
    db.prepare("UPDATE eta_settings SET pos_last_uuid = ? WHERE id = 1").run(built.uuid);
  }
  return built;
}

/** C for cash, V for card, O for wallets and sales on account: whichever paid the most. */
function paymentMethod(db: Database.Database, receiptId: number): "C" | "V" | "O" {
  const top = db.prepare("SELECT method FROM sales_receipt_payments WHERE receipt_id = ? ORDER BY amount DESC LIMIT 1").get(receiptId) as
    | { method: string }
    | undefined;
  return top?.method === "cash" ? "C" : top?.method === "card" ? "V" : "O";
}

export function recordEtaReceipt(db: Database.Database, kind: EtaReceiptKind, id: number, outcome: EtaReceiptOutcome): void {
  db.prepare(`UPDATE ${TABLE[kind]} SET eta_status = ?, eta_error = ? WHERE id = ?`).run(outcome.status, outcome.error ?? "", id);
}

/** Sends a failed or invalid receipt again, once fixed. */
export function retryEtaReceipt(db: Database.Database, kind: EtaReceiptKind, id: number): void {
  const current = db.prepare(`SELECT eta_status AS status FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!current || (current.status !== "failed" && current.status !== "invalid")) {
    throw new BusinessError("eta_not_retryable", "Only failed or invalid receipts are sent again");
  }
  // The ETA doesn't keep a refused or invalid receipt, so it goes again as a new one at the end of the chain.
  db.prepare(`UPDATE ${TABLE[kind]} SET eta_status = 'pending', eta_error = '', eta_uuid = '', eta_previous_uuid = '' WHERE id = ?`).run(id);
  issue(db, kind, id);
}

/** The QR code text for a printed receipt or return, once it is issued as an e-receipt; null otherwise. */
export function etaReceiptQrOf(db: Database.Database, kind: EtaReceiptKind, number: number): string | null {
  const r = db.prepare(`SELECT id, at, eta_uuid AS uuid, eta_status AS status FROM ${TABLE[kind]} WHERE number = ?`).get(number) as
    | { id: number; at: string; uuid: string; status: string }
    | undefined;
  if (!r || r.uuid === "" || r.status === "failed" || r.status === "invalid") return null;
  const total = (
    kind === "sale"
      ? db.prepare("SELECT SUM(net + vat) AS total FROM sales_receipt_lines WHERE receipt_id = ?").get(r.id)
      : db.prepare("SELECT SUM(net + vat) AS total FROM sales_return_lines WHERE return_id = ?").get(r.id)
  ) as { total: number };
  const { rin } = db.prepare("SELECT tax_registration_number AS rin FROM business_settings WHERE id = 1").get() as { rin: string };
  const issuedAt = new Date(Math.floor(Date.parse(r.at) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return receiptQr({ uuid: r.uuid, issuedAt, total: total.total, rin, production: row(db).environment === "production" });
}
