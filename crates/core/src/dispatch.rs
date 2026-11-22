use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::business::Business;
use crate::error::{refuse, BusinessError, Result};

/** The `index`th argument, decoded; a missing or malformed one is the screens' bug, never the user's. */
fn arg<T: DeserializeOwned>(args: &[Value], index: usize) -> Result<T> {
    let value = args.get(index).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value)
        .map_err(|e| BusinessError::new("invalid_input", format!("Argument {index}: {e}")))
}

fn json<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| BusinessError::new("internal", e.to_string()))
}

impl Business {
    /**
     * Calls a facade method by the name the screens use, with its arguments as JSON, and returns
     * its result as JSON. The names are `BUSINESS_METHODS` in `shared/api.ts`; one not ported to
     * Rust yet is refused with `not_ported`.
     */
    pub fn call(&self, method: &str, args: &[Value]) -> Result<Value> {
        match method {
            "settings" => json(self.settings()?),
            "currentUser" => json(self.current_user()),
            "licenceMode" => json(self.licence_mode()?),
            "users" => json(self.users()?),
            "addUser" => json(self.add_user(&arg(args, 0)?)?),
            "updateUser" => json(self.update_user(arg(args, 0)?, &arg(args, 1)?)?),
            "resetPassword" => json(self.reset_password(arg(args, 0)?, &arg::<String>(args, 1)?)?),
            "changeOwnPassword" => {
                json(self.change_own_password(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "deactivateUser" => json(self.deactivate_user(arg(args, 0)?)?),
            "reactivateUser" => json(self.reactivate_user(arg(args, 0)?)?),
            "auditLog" => json(self.audit_log()?),
            "accounts" => json(self.accounts()?),
            "addAccount" => json(self.add_account(&arg(args, 0)?)?),
            "updateAccount" => json(self.update_account(arg(args, 0)?, &arg(args, 1)?)?),
            "deactivateAccount" => json(self.deactivate_account(arg(args, 0)?)?),
            "reactivateAccount" => json(self.reactivate_account(arg(args, 0)?)?),
            "deleteAccount" => json(self.delete_account(arg(args, 0)?)?),
            "postJournalEntry" => json(self.post_journal_entry(&arg(args, 0)?)?),
            "postOpeningBalances" => json(
                self.post_opening_balances(&arg::<String>(args, 0)?, &arg::<Vec<_>>(args, 1)?)?,
            ),
            "trialBalance" => json(self.trial_balance(&arg::<String>(args, 0)?)?),
            "lockDate" => json(self.lock_date()?),
            "setLockDate" => json(self.set_lock_date(arg::<Option<String>>(args, 0)?.as_deref())?),
            "taxCodes" => json(self.tax_codes()?),
            "addTaxRate" => json(self.add_tax_rate(arg(args, 0)?, &arg(args, 1)?)?),
            "vatRate" => json(self.vat_rate(arg(args, 0)?, &arg::<String>(args, 1)?)?),
            "items" => json(self.items(&arg::<Option<_>>(args, 0)?.unwrap_or_default())?),
            "addItem" => json(self.add_item(&arg(args, 0)?)?),
            "updateItem" => json(self.update_item(arg(args, 0)?, &arg(args, 1)?)?),
            "deactivateItem" => json(self.deactivate_item(arg(args, 0)?)?),
            "reactivateItem" => json(self.reactivate_item(arg(args, 0)?)?),
            "findByBarcode" => json(self.find_by_barcode(&arg::<String>(args, 0)?)?),
            "warehouses" => json(self.warehouses()?),
            "addWarehouse" => json(self.add_warehouse(&arg::<String>(args, 0)?)?),
            "renameWarehouse" => {
                json(self.rename_warehouse(arg(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "deactivateWarehouse" => json(self.deactivate_warehouse(arg(args, 0)?)?),
            "reactivateWarehouse" => json(self.reactivate_warehouse(arg(args, 0)?)?),
            "stockOnHand" => json(self.stock_on_hand(arg(args, 0)?)?),
            "postOpeningStock" => json(self.post_opening_stock(
                &arg::<String>(args, 0)?,
                arg(args, 1)?,
                &arg::<Vec<_>>(args, 2)?,
            )?),
            "transferStock" => json(self.transfer_stock(&arg(args, 0)?)?),
            "transfers" => json(self.transfers()?),
            "averageCost" => json(self.average_cost(arg(args, 0)?)?),
            "stockValue" => json(self.stock_value(arg(args, 0)?)?),
            "setItemSerials" => json(self.set_item_serials(arg(args, 0)?, &arg(args, 1)?)?),
            "findSerial" => {
                json(self.find_serial(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "postStockCount" => json(self.post_stock_count(&arg(args, 0)?)?),
            "stockCounts" => json(self.stock_counts()?),
            "writeOffStock" => json(self.write_off_stock(&arg(args, 0)?)?),
            "writeOffs" => json(self.write_offs()?),
            "setItemMinimum" => json(self.set_item_minimum(arg(args, 0)?, arg(args, 1)?)?),
            "lowStock" => json(self.low_stock(arg(args, 0)?)?),
            "itemMovements" => json(self.item_movements(arg(args, 0)?, arg(args, 1)?)?),
            "suppliers" => json(self.suppliers()?),
            "addSupplier" => json(self.add_supplier(&arg(args, 0)?)?),
            "updateSupplier" => json(self.update_supplier(arg(args, 0)?, &arg(args, 1)?)?),
            "deactivateSupplier" => json(self.deactivate_supplier(arg(args, 0)?)?),
            "reactivateSupplier" => json(self.reactivate_supplier(arg(args, 0)?)?),
            "supplierBalance" => json(self.supplier_balance(arg(args, 0)?)?),
            "supplierAccount" => json(self.supplier_account(arg(args, 0)?)?),
            "pricePurchase" => json(self.price_purchase(
                &arg::<String>(args, 0)?,
                &arg::<Vec<_>>(args, 1)?,
                arg::<Option<_>>(args, 2)?.as_ref(),
            )?),
            "postPurchaseInvoice" => json(self.post_purchase_invoice(&arg(args, 0)?)?),
            "purchaseInvoices" => json(self.purchase_invoices()?),
            "postDebitNote" => json(self.post_debit_note(&arg(args, 0)?)?),
            "debitNotes" => json(self.debit_notes()?),
            _ => refuse(
                "not_ported",
                format!("{method} is not in the Rust core yet"),
            ),
        }
    }
}
