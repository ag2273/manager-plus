import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { Business } from "./business";
import { canonical } from "./eta/document";
import { type EtaReceiptClient, type EtaVerdict, refreshReceiptStatuses, sendReceipts } from "./eta/sender";

const manager = { name: "أيمن", password: "كلمة سر قوية" };
const shop = { name: "شركة النور للكمبيوتر", address: "", taxRegistrationNumber: "123456789", vatRegistered: true, fiscalYearStartMonth: 1 };
const invoicing = {
  enabled: true,
  environment: "preprod" as const,
  clientId: "client-id",
  clientSecret: "sealed-secret",
  activityCode: "4741",
  address: { governate: "الجيزة", regionCity: "الدقي", street: "شارع التحرير", buildingNumber: "12" },
  certificate: "AB12CD",
};
const pos = {
  enabled: true,
  posSerial: "POS-0001",
  posOsVersion: "windows",
  posModel: "Manager+",
  posClientId: "pos-client",
  posClientSecret: "sealed-pos-secret",
  presharedKey: "sealed-key",
};

/** An ETA receipt API that takes what it is sent, unless told to refuse a receipt number or to be down. */
function fakeEta(options: { refuse?: Record<string, string> } = {}) {
  const received: Record<string, unknown>[] = [];
  const verdicts = new Map<string, EtaVerdict>();
  const state = { down: false };
  const client: EtaReceiptClient = {
    async submitReceipts(receipts) {
      if (state.down) throw new Error("ECONNREFUSED");
      received.push(...receipts);
      const accepted = [];
      const rejected = [];
      for (const r of receipts) {
        const header = r["header"] as { uuid: string; receiptNumber: string };
        const refusal = options.refuse?.[header.receiptNumber];
        if (refusal) rejected.push({ uuid: header.uuid, error: refusal });
        else accepted.push({ uuid: header.uuid });
      }
      return { accepted, rejected };
    },
    async receiptStatus(uuid) {
      return verdicts.get(uuid) ?? { status: "submitted" };
    },
  };
  return { client, received, verdicts, state };
}

const header = (r: Record<string, unknown>) => r["header"] as { uuid: string; previousUUID: string; referenceOldUUID: string; receiptNumber: string };

function sample(options: { receipts?: boolean } = {}) {
  const business = Business.create(":memory:", shop, manager);
  const main = business.warehouses()[0]!.id;
  const standard = business.taxCodes().find((c) => c.kind === "standard")!.id;
  const router = business.addItem({
    nameAr: "راوتر واي فاي 6",
    baseUnit: "قطعة",
    salePrice: 114_000,
    taxCodeId: standard,
    egsCode: "EG-123456789-1001",
  });
  const cable = business.addItem({ nameAr: "كابل شبكة", baseUnit: "قطعة", salePrice: 5_700, taxCodeId: standard });
  const supplier = business.addSupplier({ name: "المورد", phone: "", taxRegistrationNumber: "" });
  business.postPurchaseInvoice({
    date: "2026-11-01",
    supplierId: supplier,
    warehouseId: main,
    reference: "",
    lines: [
      { itemId: router, unit: "base", quantity: 20_000, unitPrice: 80_000 },
      { itemId: cable, unit: "base", quantity: 20_000, unitPrice: 3_000 },
    ],
  });
  if (options.receipts !== false) {
    business.setEtaSettings(invoicing);
    business.setEtaReceiptSettings(pos);
  }
  business.openShift(0);
  const sell = (itemId = router, method: "cash" | "card" = "cash") =>
    business.postSale({
      date: "2026-11-20",
      warehouseId: main,
      lines: [{ itemId, unit: "base", quantity: 1_000 }],
      payments: [{ method, amount: 114_000 }],
    });
  return { business, router, cable, sell, eta: fakeEta() };
}

describe("e-receipts are optional", () => {
  test("they are off by default, need e-invoicing on and every POS detail", () => {
    const { business, sell } = sample({ receipts: false });
    expect(business.etaReceiptSettings()).toMatchObject({ enabled: false, hasPosSecrets: false });
    sell();
    expect(business.etaReceipts()).toEqual([]);
    expect(() => business.setEtaReceiptSettings(pos)).toThrow(expect.objectContaining({ code: "eta_not_enabled" }));
    business.setEtaSettings(invoicing);
    expect(() => business.setEtaReceiptSettings({ ...pos, posSerial: " " })).toThrow(expect.objectContaining({ code: "eta_settings_incomplete" }));
    business.setEtaReceiptSettings(pos);
    expect(business.etaReceiptSettings()).toMatchObject({ enabled: true, posSerial: "POS-0001", hasPosSecrets: true });
    // Saving without the secrets keeps the sealed ones.
    business.setEtaReceiptSettings({
      enabled: true,
      posSerial: "POS-0001",
      posOsVersion: "windows",
      posModel: "Manager+",
      posClientId: "pos-client",
    });
    expect(business.etaReceiptCredentials()).toMatchObject({ production: false, posClientSecret: "sealed-pos-secret", presharedKey: "sealed-key" });
  });
});

describe("sending e-receipts", () => {
  test("sales made offline wait, then go in order, each naming the one before it", async () => {
    const { business, sell, eta } = sample();
    sell();
    sell(undefined, "card");
    expect(business.etaReceipts().map((r) => r.status)).toEqual(["pending", "pending"]);

    eta.state.down = true;
    await expect(sendReceipts(business.etaReceiptBooks(), eta.client)).rejects.toMatchObject({ code: "eta_unreachable" });
    expect(business.etaReceipts().map((r) => r.status)).toEqual(["pending", "pending"]);

    eta.state.down = false;
    sell();
    expect(await sendReceipts(business.etaReceiptBooks(), eta.client)).toBe(3);
    const sent = eta.received.slice(-3);
    expect(sent.map((r) => header(r).receiptNumber)).toEqual(["S-1", "S-2", "S-3"]);
    expect(header(sent[0]!).previousUUID).toBe("");
    expect(header(sent[1]!).previousUUID).toBe(header(sent[0]!).uuid);
    expect(header(sent[2]!).previousUUID).toBe(header(sent[1]!).uuid);
    // The ones sent while the ETA was down are sent again with the same UUID.
    expect(header(eta.received[0]!).uuid).toBe(header(sent[0]!).uuid);
    expect(sent.map((r) => r["paymentMethod"])).toEqual(["C", "V", "C"]);
    expect(business.etaReceipts().map((r) => r.status)).toEqual(["submitted", "submitted", "submitted"]);
  });

  test("the UUID is the SHA-256 of the receipt's canonical form with an empty UUID", async () => {
    const { business, sell, eta } = sample();
    sell();
    await sendReceipts(business.etaReceiptBooks(), eta.client);
    const receipt = eta.received[0]!;
    const blank = { ...receipt, header: { ...header(receipt), uuid: "" } };
    expect(header(receipt).uuid).toBe(createHash("sha256").update(canonical(blank)).digest("hex"));
    expect(receipt).toMatchObject({
      documentType: { receiptType: "S", typeVersion: "1.2" },
      seller: { rin: "123456789", deviceSerialNumber: "POS-0001", activityCode: "4741" },
      totalAmount: 1140,
      netAmount: 1000,
      taxTotals: [{ taxType: "T1", amount: 140 }],
    });
  });

  test("a receipt that can't be issued fails and the till goes on; fixed, it goes again at the end of the chain", async () => {
    const { business, cable, sell, eta } = sample();
    sell();
    sell(cable);
    sell();
    expect(business.etaReceipts().map((r) => [r.number, r.status])).toEqual([
      [1, "pending"],
      [2, "failed"],
      [3, "pending"],
    ]);
    expect(business.etaReceipts()[1]!.error).toBe("eta_item_code_required: كابل شبكة");
    await sendReceipts(business.etaReceiptBooks(), eta.client);
    expect(eta.received.map((r) => header(r).receiptNumber)).toEqual(["S-1", "S-3"]);
    expect(header(eta.received[1]!).previousUUID).toBe(header(eta.received[0]!).uuid);

    business.updateItem(cable, { egsCode: "EG-123456789-1002" });
    business.retryEtaReceipt("sale", business.etaReceipts()[1]!.id);
    await sendReceipts(business.etaReceiptBooks(), eta.client);
    expect(business.etaReceipts().map((r) => r.status)).toEqual(["submitted", "submitted", "submitted"]);
    expect(header(eta.received[2]!)).toMatchObject({ receiptNumber: "S-2", previousUUID: header(eta.received[1]!).uuid });
  });

  test("a refused receipt fails with the ETA's reason; an invalid one goes again with a new UUID", async () => {
    const { business, sell } = sample();
    const eta = fakeEta({ refuse: { "S-1": "Seller activity code is not valid" } });
    sell();
    await sendReceipts(business.etaReceiptBooks(), eta.client);
    expect(business.etaReceipts()[0]).toMatchObject({ status: "failed", error: "eta_rejected: Seller activity code is not valid" });

    sell();
    const ok = fakeEta();
    business.retryEtaReceipt("sale", business.etaReceipts()[0]!.id);
    await sendReceipts(business.etaReceiptBooks(), ok.client);
    const second = business.etaReceipts()[1]!;
    ok.verdicts.set(second.uuid, { status: "invalid", error: "Total is wrong" });
    await refreshReceiptStatuses(business.etaReceiptBooks(), ok.client);
    expect(business.etaReceipts()[1]).toMatchObject({ status: "invalid", error: "eta_rejected: Total is wrong" });
    expect(() => business.retryEtaReceipt("sale", business.etaReceipts()[0]!.id)).toThrow(expect.objectContaining({ code: "eta_not_retryable" }));

    business.retryEtaReceipt("sale", second.id);
    await sendReceipts(business.etaReceiptBooks(), ok.client);
    const again = header(ok.received.at(-1)!);
    expect(again.uuid).not.toBe(second.uuid);
    // It names the last receipt issued: the first one, sent again before it.
    expect(again.previousUUID).toBe(business.etaReceipts()[0]!.uuid);
  });

  test("a return names its sale; a return of a sale made before e-receipts is not sent", async () => {
    const { business, sell, eta } = sample({ receipts: false });
    const before = business.findReceipt(sell().number);
    business.setEtaSettings(invoicing);
    business.setEtaReceiptSettings(pos);
    const after = business.findReceipt(sell().number);
    business.returnSale({ date: "2026-11-21", receiptId: before.id, lines: [{ lineId: before.lines[0]!.lineId, quantity: 1_000 }], refund: "cash" });
    business.returnSale({ date: "2026-11-21", receiptId: after.id, lines: [{ lineId: after.lines[0]!.lineId, quantity: 1_000 }], refund: "cash" });
    expect(business.etaReceipts().map((r) => [r.kind, r.number])).toEqual([
      ["sale", 2],
      ["return", 2],
    ]);

    await sendReceipts(business.etaReceiptBooks(), eta.client);
    const [sale, refund] = eta.received;
    expect(refund).toMatchObject({ documentType: { receiptType: "R" }, totalAmount: 1140 });
    expect(header(refund!)).toMatchObject({ receiptNumber: "R-2", referenceOldUUID: header(sale!).uuid, previousUUID: header(sale!).uuid });
  });

  test("the printed receipt carries its QR code from the sale on, even offline", async () => {
    const { business, cable, sell, eta } = sample();
    sell();
    sell(cable);
    expect(business.etaReceiptQr("sale", 2)).toBeNull();
    const uuid = business.etaReceipts()[0]!.uuid;
    expect(business.etaReceiptQr("sale", 1)).toMatch(
      new RegExp(
        `^https://preprod\\.invoicing\\.eta\\.gov\\.eg/receipts/search/${uuid}/share/\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ#Total:1140,IssuerRIN:123456789$`,
      ),
    );
    await sendReceipts(business.etaReceiptBooks(), eta.client);
    expect(header(eta.received[0]!).uuid).toBe(uuid);
  });
});
