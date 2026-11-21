/**
 * The columns of the import template, in Arabic and English. A sheet is recognised by its header
 * row, in either language and in any order; columns not listed are ignored.
 */
export type ImportColumn<K extends string> = { key: K; ar: string; en: string; required?: boolean; example: { ar: string; en: string } };

export type ItemColumnKey =
  | "nameAr"
  | "nameEn"
  | "code"
  | "baseUnit"
  | "barcode"
  | "salePrice"
  | "wholesalePrice"
  | "tax"
  | "packName"
  | "packSize"
  | "packBarcode"
  | "packPrice"
  | "openingQuantity"
  | "unitCost";
export type BalanceColumnKey = "type" | "name" | "debit" | "credit";

const same = (value: string) => ({ ar: value, en: value });

export const ITEM_COLUMNS: ImportColumn<ItemColumnKey>[] = [
  { key: "nameAr", ar: "اسم الصنف بالعربية", en: "Arabic name", required: true, example: same("راوتر واي فاي 6") },
  { key: "nameEn", ar: "الاسم بالإنجليزية", en: "English name", example: same("WiFi 6 router") },
  { key: "code", ar: "كود الصنف", en: "Item code", example: same("R-100") },
  { key: "baseUnit", ar: "الوحدة", en: "Unit", required: true, example: { ar: "قطعة", en: "piece" } },
  { key: "barcode", ar: "الباركود", en: "Barcode", example: same("6221234567890") },
  { key: "salePrice", ar: "سعر البيع شامل الضريبة", en: "Sale price incl. VAT", required: true, example: same("1500.00") },
  { key: "wholesalePrice", ar: "سعر الجملة", en: "Wholesale price", example: same("1400.00") },
  { key: "tax", ar: "الضريبة", en: "Tax", example: { ar: "عام", en: "standard" } },
  { key: "packName", ar: "وحدة العبوة", en: "Pack unit", example: { ar: "كرتونة", en: "carton" } },
  { key: "packSize", ar: "عدد الوحدات في العبوة", en: "Units per pack", example: same("10") },
  { key: "packBarcode", ar: "باركود العبوة", en: "Pack barcode", example: same("16221234567897") },
  { key: "packPrice", ar: "سعر العبوة", en: "Pack price", example: same("14500.00") },
  { key: "openingQuantity", ar: "الكمية الافتتاحية", en: "Opening quantity", example: same("25") },
  { key: "unitCost", ar: "تكلفة الوحدة", en: "Unit cost", example: same("1100.00") },
];

export const BALANCE_COLUMNS: ImportColumn<BalanceColumnKey>[] = [
  { key: "type", ar: "النوع", en: "Type", required: true, example: { ar: "عميل", en: "customer" } },
  { key: "name", ar: "الاسم أو كود الحساب", en: "Name or account code", required: true, example: { ar: "شركة الأمل", en: "Al Amal Co." } },
  { key: "debit", ar: "مدين", en: "Debit", example: same("12500.00") },
  { key: "credit", ar: "دائن", en: "Credit", example: same("") },
];

/** The words accepted in the Tax and Type columns, in either language. */
export const TAX_WORDS: Record<string, "standard" | "zero_rated" | "exempt"> = {
  "": "standard",
  عام: "standard",
  خاضع: "standard",
  standard: "standard",
  صفر: "zero_rated",
  "zero-rated": "zero_rated",
  zero_rated: "zero_rated",
  zero: "zero_rated",
  معفى: "exempt",
  معفي: "exempt",
  exempt: "exempt",
};
export const BALANCE_TYPES: Record<string, "account" | "customer" | "supplier"> = {
  حساب: "account",
  account: "account",
  عميل: "customer",
  customer: "customer",
  مورد: "supplier",
  supplier: "supplier",
};

export const SHEET_NAMES = {
  items: { ar: "الأصناف", en: "Items" },
  balances: { ar: "الأرصدة الافتتاحية", en: "Opening balances" },
} as const;
