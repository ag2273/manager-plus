# VAT return built from documents, checked against the ledger

The VAT return lists the documents behind each figure: till sales and returns, sales invoices and credit notes, EGP purchase invoices and debit notes, expenses with VAT (a voided expense counts again, negative, on the date it was voided), and VAT paid at customs on import shipments. Purchases from foreign-currency suppliers are imports: they carry no Egyptian VAT, and their VAT is the customs VAT on the shipment.

A line's tax kind is "standard" when it carried VAT. A line at 0% takes its item's tax code, so zero-rated and exempt sales stay apart. Lines don't store their tax code, so changing an item's code later moves its old 0% lines between zero-rated and exempt. Lines that carried VAT are not affected.

The return also shows how far the VAT accounts moved beyond those documents, for example a journal entry posted straight to input VAT. The net due uses the ledger figures, so the return always agrees with the VAT accounts. When the documents explain everything, the adjustment lines are zero and hidden.

Layout still to be confirmed by the accountant (see the PRD checklist).
