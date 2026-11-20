import { BusinessError } from "./errors";

/** Throws `date_invalid` unless `date` is a real calendar date written YYYY-MM-DD. */
export function assertIsoDate(date: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const valid =
    match !== null &&
    (() => {
      const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const parsed = new Date(Date.UTC(y, m - 1, d));
      return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
    })();
  if (!valid) throw new BusinessError("date_invalid", `Not a valid date: "${date}"`);
}
