import type { IsoDate, Piastres } from "./ledger";
/** Integer thousandths of an item's base unit: 1000 = one piece or one kilogram. */
export type Quantity = number;
/** Basis points: 1400 = 14%. */
export type BasisPoints = number;
export type TaxCodeKind = "standard" | "zero_rated" | "exempt";
export type TaxCode = {
    id: number;
    kind: TaxCodeKind;
    name: string;
    rates: {
        from: IsoDate;
        rate: BasisPoints;
    }[];
};
export type PackUnit = {
    name: string;
    size: Quantity;
    barcode: string | null;
    salePrice: Piastres;
    wholesalePrice: Piastres | null;
};
export type Item = {
    id: number;
    nameAr: string;
    nameEn: string;
    code: string | null;
    baseUnit: string;
    barcode: string | null;
    /** VAT-inclusive price of one base unit. */
    salePrice: Piastres;
    /** VAT-inclusive price for wholesale customers; the retail price when not set. */
    wholesalePrice: Piastres | null;
    taxCodeId: number;
    egsCode: string;
    pack: PackUnit | null;
    /** Every unit carries its own serial number on every document. */
    serialised: boolean;
    warrantyMonths: number;
    active: boolean;
};
export type PackUnitInput = {
    name: string;
    size: Quantity;
    barcode?: string;
    salePrice: Piastres;
    wholesalePrice?: Piastres | null;
};
export type ItemInput = {
    nameAr: string;
    nameEn?: string;
    code?: string;
    baseUnit: string;
    barcode?: string;
    salePrice: Piastres;
    wholesalePrice?: Piastres | null;
    taxCodeId: number;
    egsCode?: string;
    pack?: PackUnitInput | null;
};
export type ItemChanges = Partial<ItemInput>;
export type ScannedUnit = {
    itemId: number;
    nameAr: string;
    unit: "base" | "pack";
    unitName: string;
    /** How much of the base unit one of this unit is. */
    quantity: Quantity;
    salePrice: Piastres;
    taxCodeId: number;
    /** A serialised item is added at the till by scanning each unit's serial, not its barcode. */
    serialised: boolean;
};
