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
            "setupStatus" => json(self.setup_status()?),
            "finishSetup" => json(self.finish_setup(arg(args, 0)?)?),
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
            "itemSerials" => json(self.item_serials(arg(args, 0)?)?),
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
            "customers" => json(self.customers()?),
            "addCustomer" => json(self.add_customer(&arg(args, 0)?)?),
            "updateCustomer" => json(self.update_customer(arg(args, 0)?, &arg(args, 1)?)?),
            "deactivateCustomer" => json(self.deactivate_customer(arg(args, 0)?)?),
            "reactivateCustomer" => json(self.reactivate_customer(arg(args, 0)?)?),
            "customerBalance" => json(self.customer_balance(arg(args, 0)?)?),
            "openShift" => json(self.open_shift(arg(args, 0)?)?),
            "currentShift" => json(self.current_shift()?),
            "cashInOut" => json(self.cash_in_out(&arg(args, 0)?)?),
            "closeShift" => json(self.close_shift(&arg(args, 0)?)?),
            "zReport" => json(self.z_report(arg(args, 0)?)?),
            "shifts" => json(self.shifts()?),
            "priceSale" => json(self.price_sale(
                &arg::<String>(args, 0)?,
                &arg::<Vec<_>>(args, 1)?,
                arg::<Option<_>>(args, 2)?.as_ref(),
            )?),
            "holdSale" => json(self.hold_sale(&arg(args, 0)?)?),
            "heldSales" => json(self.held_sales()?),
            "recallSale" => json(self.recall_sale(arg(args, 0)?)?),
            "postCashSale" => json(self.post_cash_sale(&arg(args, 0)?)?),
            "postSale" => json(self.post_sale(&arg(args, 0)?)?),
            "findReceipt" => json(self.find_receipt(arg(args, 0)?)?),
            "receipts" => json(self.receipts()?),
            "searchReceipts" => json(self.search_receipts(&arg(args, 0)?)?),
            "returnSale" => json(self.return_sale(&arg(args, 0)?)?),
            "findReturn" => json(self.find_return(arg(args, 0)?)?),
            "priceInvoice" => {
                json(self.price_invoice(&arg::<String>(args, 0)?, &arg::<Vec<_>>(args, 1)?)?)
            }
            "postSalesInvoice" => json(self.post_sales_invoice(&arg(args, 0)?)?),
            "salesInvoices" => json(self.sales_invoices()?),
            "findSalesInvoice" => json(self.find_sales_invoice(arg(args, 0)?)?),
            "postCreditNote" => json(self.post_credit_note(&arg(args, 0)?)?),
            "findCreditNote" => json(self.find_credit_note(arg(args, 0)?)?),
            "listPrice" => json(self.list_price(
                arg(args, 0)?,
                arg(args, 1)?,
                &arg::<String>(args, 2)?,
                &arg::<String>(args, 3)?,
            )?),
            "saveQuotation" => json(self.save_quotation(&arg(args, 0)?)?),
            "quotations" => json(self.quotations(&arg::<String>(args, 0)?)?),
            "findQuotation" => json(self.find_quotation(arg(args, 0)?, &arg::<String>(args, 1)?)?),
            "backupStatus" => json(self.backup_status()?),
            "setBackupFolder" => {
                json(self.set_backup_folder(arg::<Option<String>>(args, 0)?.as_deref())?)
            }
            "backupNow" => json(self.backup_now()?),
            "profitAndLoss" => {
                json(self.profit_and_loss(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "balanceSheet" => json(self.balance_sheet(&arg::<String>(args, 0)?)?),
            "generalLedger" => json(self.general_ledger(
                arg(args, 0)?,
                &arg::<String>(args, 1)?,
                &arg::<String>(args, 2)?,
            )?),
            "journalEntry" => json(self.journal_entry(arg(args, 0)?)?),
            "salesByItem" => {
                json(self.sales_by_item(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "salesByDay" => {
                json(self.sales_by_day(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "salesByPaymentMethod" => json(
                self.sales_by_payment_method(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?,
            ),
            "salesDocuments" => {
                json(self.sales_documents(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "stockAt" => json(self.stock_at(&arg::<String>(args, 0)?)?),
            "vatReturn" => {
                json(self.vat_return(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "dashboard" => json(self.dashboard(&arg::<String>(args, 0)?)?),
            "checkImport" => json(self.check_import(&arg(args, 0)?)?),
            "importData" => json(self.import_data(&arg(args, 0)?)?),
            "postImportShipment" => json(self.post_import_shipment(&arg(args, 0)?)?),
            "importShipments" => json(self.import_shipments()?),
            "moneyAccounts" => json(self.money_accounts(&arg::<String>(args, 0)?)?),
            "recordExpense" => json(self.record_expense(&arg(args, 0)?)?),
            "expenses" => json(self.expenses()?),
            "transferMoney" => json(self.transfer_money(&arg(args, 0)?)?),
            "moneyTransfers" => json(self.money_transfers()?),
            "accountLines" => json(self.account_lines(
                arg(args, 0)?,
                &arg::<String>(args, 1)?,
                &arg::<String>(args, 2)?,
            )?),
            "setCleared" => {
                json(self.set_cleared(arg(args, 0)?, &arg::<Vec<i64>>(args, 1)?, arg(args, 2)?)?)
            }
            "reconciliation" => json(self.reconciliation(arg(args, 0)?, arg(args, 1)?)?),
            "voidEntry" => json(self.void_entry(arg(args, 0)?, &arg::<String>(args, 1)?)?),
            "withholdingCategories" => json(self.withholding_categories()?),
            "addWithholdingRate" => json(self.add_withholding_rate(arg(args, 0)?, &arg(args, 1)?)?),
            "withholdingTax" => json(self.withholding_tax(
                arg(args, 0)?,
                &arg::<String>(args, 1)?,
                arg(args, 2)?,
            )?),
            "withholdingReport" => {
                json(self.withholding_report(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "receiveCustomerPayment" => json(self.receive_customer_payment(&arg(args, 0)?)?),
            "paySupplier" => json(self.pay_supplier(&arg(args, 0)?)?),
            "openDocuments" => json(self.open_documents(arg(args, 0)?, arg(args, 1)?)?),
            "statement" => json(self.statement(
                arg(args, 0)?,
                arg(args, 1)?,
                &arg::<String>(args, 2)?,
                &arg::<String>(args, 3)?,
            )?),
            "aging" => json(self.aging(arg(args, 0)?, &arg::<String>(args, 1)?)?),
            "etaSettings" => json(self.eta_settings()?),
            "etaDocuments" => json(self.eta_documents()?),
            "etaState" => json(self.eta_state(&arg::<String>(args, 0)?, arg(args, 1)?)?),
            "retryEta" => json(self.retry_eta(&arg::<String>(args, 0)?, arg(args, 1)?)?),
            "etaReceiptSettings" => json(self.eta_receipt_settings()?),
            "etaReceipts" => json(self.eta_receipts()?),
            "retryEtaReceipt" => {
                json(self.retry_eta_receipt(&arg::<String>(args, 0)?, arg(args, 1)?)?)
            }
            "etaReceiptQr" => json(self.eta_receipt_qr(&arg::<String>(args, 0)?, arg(args, 1)?)?),
            _ if crate::methods::is_business_method(method) => refuse(
                "not_ported",
                format!("{method} is not in the Rust core yet"),
            ),
            _ => refuse("not_allowed", format!("Not a business method: {method}")),
        }
    }
}
