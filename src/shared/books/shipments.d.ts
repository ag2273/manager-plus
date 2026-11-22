import type { Quantity } from "./items";
import type { IsoDate, Piastres } from "./ledger";
export type ShipmentCostKind = "customs_duty" | "freight" | "clearance" | "insurance" | "other";
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
    costLines: (ShipmentCostInput & {
        payee: string;
    })[];
    /** The goods in EGP, the costs spread over them (without VAT), and the VAT paid on the costs. */
    goods: Piastres;
    costs: Piastres;
    vat: Piastres;
    lines: ShipmentLine[];
};
