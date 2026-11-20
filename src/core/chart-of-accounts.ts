export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

/**
 * Roles mark the accounts the app posts to automatically. An account with a
 * role can be renamed or renumbered but never deleted, and its type is fixed.
 */
export type AccountRole =
  | "cash_drawer"
  | "main_cash"
  | "bank"
  | "wallet"
  | "card_clearing"
  | "receivables"
  | "stock"
  | "input_vat"
  | "payables"
  | "output_vat"
  | "vat_payable"
  | "capital"
  | "owner_drawings"
  | "retained_earnings"
  | "opening_balances"
  | "sales"
  | "stock_gain"
  | "cash_over"
  | "cost_of_goods_sold"
  | "stock_loss"
  | "cash_short";

type TemplateAccount = { code: string; name: string; type: AccountType; role?: AccountRole };

/**
 * Egyptian retail chart of accounts every new business starts with.
 * Draft pending the accountant's review (see the BRD).
 */
export const RETAIL_CHART_OF_ACCOUNTS: readonly TemplateAccount[] = [
  { code: "1100", name: "نقدية الدرج", type: "asset", role: "cash_drawer" },
  { code: "1110", name: "الخزينة الرئيسية", type: "asset", role: "main_cash" },
  { code: "1120", name: "البنك", type: "asset", role: "bank" },
  { code: "1130", name: "المحافظ الإلكترونية / إنستاباي", type: "asset", role: "wallet" },
  { code: "1140", name: "حساب وسيط مدفوعات البطاقات", type: "asset", role: "card_clearing" },
  { code: "1200", name: "العملاء", type: "asset", role: "receivables" },
  { code: "1300", name: "المخزون", type: "asset", role: "stock" },
  { code: "1400", name: "ضريبة القيمة المضافة على المشتريات", type: "asset", role: "input_vat" },
  { code: "1500", name: "أثاث وتجهيزات المحل", type: "asset" },
  { code: "2100", name: "الموردون", type: "liability", role: "payables" },
  { code: "2200", name: "ضريبة القيمة المضافة على المبيعات", type: "liability", role: "output_vat" },
  { code: "2300", name: "ضريبة القيمة المضافة المستحقة للمصلحة", type: "liability", role: "vat_payable" },
  { code: "2400", name: "مصروفات مستحقة", type: "liability" },
  { code: "3100", name: "رأس المال", type: "equity", role: "capital" },
  { code: "3200", name: "جاري صاحب المحل", type: "equity", role: "owner_drawings" },
  { code: "3300", name: "الأرباح المحتجزة", type: "equity", role: "retained_earnings" },
  { code: "3900", name: "أرصدة افتتاحية", type: "equity", role: "opening_balances" },
  { code: "4100", name: "المبيعات", type: "income", role: "sales" },
  { code: "4200", name: "أرباح جرد المخزون", type: "income", role: "stock_gain" },
  { code: "4300", name: "زيادة نقدية الدرج", type: "income", role: "cash_over" },
  { code: "5100", name: "تكلفة البضاعة المباعة", type: "expense", role: "cost_of_goods_sold" },
  { code: "5200", name: "خسائر وإعدام مخزون", type: "expense", role: "stock_loss" },
  { code: "6100", name: "الإيجار", type: "expense" },
  { code: "6200", name: "الكهرباء والمياه", type: "expense" },
  { code: "6300", name: "الأجور والمرتبات", type: "expense" },
  { code: "6400", name: "النقل والمشال", type: "expense" },
  { code: "6500", name: "عمولات البنوك والبطاقات", type: "expense" },
  { code: "6600", name: "مصروفات متنوعة", type: "expense" },
  { code: "6700", name: "عجز نقدية الدرج", type: "expense", role: "cash_short" },
];
