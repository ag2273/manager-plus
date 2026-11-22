/** The currencies a supplier can bill in, with their ISO code and digits after the point. */
export type Currency = "EGP" | "USD" | "EUR" | "CNY";
/** EGP per one unit of a currency, in integer millionths: 48.50 is 48_500_000. */
export type Rate = number;
