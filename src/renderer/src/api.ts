import { BUSINESS_METHODS, type RemoteBusiness, type Result } from "../../shared/api";
import { ar } from "./strings";

/** Fired when a call could not reach the server PC, and again once one gets through. */
export const SERVER_LOST = "manager-plus:server-lost";
export const SERVER_BACK = "manager-plus:server-back";
let lost = false;

/** The open business. Each call crosses to the main process and returns a Result. */
export const business = Object.fromEntries(
  BUSINESS_METHODS.map((method) => [
    method,
    async (...args: unknown[]) => {
      const result = await window.api.call(method, args);
      const unreachable = !result.ok && result.code === "server_unreachable";
      if (unreachable !== lost) {
        lost = unreachable;
        window.dispatchEvent(new Event(unreachable ? SERVER_LOST : SERVER_BACK));
      }
      return result;
    },
  ]),
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
