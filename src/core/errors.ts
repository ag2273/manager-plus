/**
 * Every rule the core refuses carries a stable `code`. Screens translate the
 * code into Arabic or English; the message is for logs and developers only.
 */
export type BusinessErrorCode =
  | "name_required"
  | "tax_registration_number_invalid"
  | "fiscal_year_start_month_invalid"
  | "file_exists"
  | "file_not_found"
  | "not_a_business_file"
  | "made_by_newer_version";

export class BusinessError extends Error {
  constructor(
    readonly code: BusinessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BusinessError";
  }
}
