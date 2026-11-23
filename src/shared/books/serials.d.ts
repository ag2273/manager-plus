import type { IsoDate } from "./ledger";
/** Where one unit of a serialised item has been and where it is now. */
export type SerialHistory = {
    itemId: number;
    nameAr: string;
    serial: string;
    inStock: boolean;
    /** The warehouse it is in, or null when it is out of stock. */
    warehouseId: number | null;
    purchase: {
        date: IsoDate;
        supplierId: number;
        supplierName: string;
        reference: string;
    } | null;
    sale: {
        date: IsoDate;
        document: string;
        customerId: number | null;
        customerName: string | null;
    } | null;
    /** Sale date + warranty months; null when not sold or the item has no warranty. */
    warrantyEnds: IsoDate | null;
    underWarranty: boolean;
};
/** One unit of a serialised item that is in stock: where it is, and since when. */
export type StockSerial = {
    serial: string;
    warehouseId: number;
    warehouseName: string;
    /** The date it came into that warehouse. */
    since: IsoDate;
};
export {};
