export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
/**
 * Roles mark the accounts the app posts to automatically. An account with a
 * role can be renamed or renumbered but never deleted, and its type is fixed.
 */
export type AccountRole = "cash_drawer" | "main_cash" | "bank" | "wallet" | "card_clearing" | "receivables" | "stock" | "input_vat" | "payables" | "output_vat" | "vat_payable" | "capital" | "owner_drawings" | "retained_earnings" | "opening_balances" | "sales" | "stock_gain" | "cash_over" | "cost_of_goods_sold" | "stock_loss" | "cash_short" | "exchange_gain" | "exchange_loss" | "withholding_receivable" | "withholding_payable";
export {};
