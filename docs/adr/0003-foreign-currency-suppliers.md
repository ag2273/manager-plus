# 3. Foreign-currency suppliers: the ledger stays in EGP, payables also carry the supplier's currency

Date: 2026-11-21 · Status: accepted

Importers buy in USD, EUR or CNY. A supplier has one currency, fixed once anything is posted for them. Their invoices, debit notes and payments are typed in that currency with an exchange rate on each document.

- **Rates** are EGP per one unit of the currency, stored as integer millionths (48.50 → 48 500 000). Amounts convert with exact integer arithmetic and round half-up to the piastre.
- **The ledger stays in EGP.** Every payables line of a foreign supplier also records the same amount in the supplier's currency (`ledger_lines.foreign_amount`). The supplier's balance in their currency, their statement and the documents open for payment come from that column; the trial balance and every report come from the EGP columns as always.
- **Each document keeps its own rate.** A debit note goes back at its invoice's rate. A payment takes each invoice it settles off the books at that invoice's rate (allocated as typed, the rest oldest first, stored per allocation). The difference against what was paid posts in the same entry to *Exchange loss* (5300) or *Exchange gain* (4400), new system accounts.
- **Money paid ahead of any invoice** is carried at the payment's own rate. If a later invoice is matched to it at another rate, the small EGP difference stays on the supplier's account; month-end revaluation of open balances is not done yet.
- **No Egyptian VAT on a foreign supplier's invoice.** VAT on imports is paid at customs and belongs to import shipments (#31).
- **Aging** stays in EGP at the documents' own rates so the totals across suppliers add up; the statement is in the supplier's currency.

Open question for the accountant: which rate is typed on the documents, the Central Bank of Egypt's published rate for the day or the bank's actual rate on the transfer? The app takes whatever is typed.
