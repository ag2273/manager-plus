import type { Currency } from "./books/currency";

/** The currencies a supplier's invoice may be in, as the core accepts them. */
export const CURRENCIES: readonly Currency[] = ["EGP", "USD", "EUR", "CNY"];
