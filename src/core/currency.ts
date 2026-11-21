import { BusinessError } from "./errors";
import type { Piastres } from "./ledger";

/** The currencies a supplier can bill in, with their ISO code and digits after the point. */
export type Currency = "EGP" | "USD" | "EUR" | "CNY";
export const CURRENCIES: readonly { code: Currency; minorUnits: number; nameAr: string }[] = [
  { code: "EGP", minorUnits: 2, nameAr: "جنيه مصري" },
  { code: "USD", minorUnits: 2, nameAr: "دولار أمريكي" },
  { code: "EUR", minorUnits: 2, nameAr: "يورو" },
  { code: "CNY", minorUnits: 2, nameAr: "يوان صيني" },
];

/** EGP per one unit of a currency, in integer millionths: 48.50 is 48_500_000. */
export type Rate = number;
export const ONE: Rate = 1_000_000;

/** A rate that can be posted: a positive whole number of millionths, and exactly one for EGP. */
export function assertRate(currency: Currency, rate: Rate): void {
  if (!Number.isSafeInteger(rate) || rate <= 0) throw new BusinessError("rate_invalid", `Rate ${rate} is not a positive number of millionths`);
  if (currency === "EGP" && rate !== ONE) throw new BusinessError("rate_invalid", "An EGP document has no exchange rate");
}

/** An amount in a currency's minor units turned into piastres, half-up, exactly (no floating point). */
export function toEgp(amount: number, rate: Rate): Piastres {
  const product = BigInt(amount) * BigInt(rate);
  const half = BigInt(ONE / 2);
  const egp = product >= 0n ? (product + half) / BigInt(ONE) : -((-product + half) / BigInt(ONE));
  return Number(egp);
}
