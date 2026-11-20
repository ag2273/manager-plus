import { BUSINESS_METHODS, type RemoteBusiness, type Result } from "../../shared/api";
import { ar } from "./strings";

/** The open business. Each call crosses to the main process and returns a Result. */
export const business = Object.fromEntries(
  BUSINESS_METHODS.map((method) => [method, (...args: unknown[]) => window.api.call(method, args)]),
) as unknown as RemoteBusiness;

/** The Arabic message for a failed result, or null when it succeeded. */
export function errorText(result: Result<unknown>): string | null {
  if (result.ok) return null;
  return ar.errors[result.code] ?? ar.errors["unexpected"]!;
}

/** Today's date on this computer, as YYYY-MM-DD. */
export function today(): string {
  return new Date().toLocaleDateString("en-CA");
}
