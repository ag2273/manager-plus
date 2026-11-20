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
  | "made_by_newer_version"
  | "date_invalid"
  | "entry_needs_two_lines"
  | "entry_unbalanced"
  | "line_amount_invalid"
  | "account_not_found"
  | "account_inactive"
  | "account_code_required"
  | "account_name_required"
  | "account_code_taken"
  | "account_type_invalid"
  | "account_is_system"
  | "account_has_postings"
  | "tax_code_not_found"
  | "tax_rate_invalid"
  | "tax_rate_missing"
  | "item_not_found"
  | "item_name_required"
  | "item_unit_required"
  | "item_code_taken"
  | "barcode_taken"
  | "price_invalid"
  | "pack_size_invalid";

export class BusinessError extends Error {
  constructor(
    readonly code: BusinessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BusinessError";
  }
}
