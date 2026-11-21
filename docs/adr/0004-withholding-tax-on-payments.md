# Withholding tax is taken on payments, with a base the user enters

Egyptian withholding tax (الخصم والإضافة) is recorded on the payment voucher, not on the invoice.
A payment's `amount` stays the full amount it settles on the party's account; the cash or bank
line moves `amount` less the tax, and the tax goes to Withholding tax payable (when we pay a
supplier) or Withholding tax receivable (when a company customer pays us).

The tax is the category's rate, in force on the payment date, times a base the user types: the
documents' value before VAT. We do not derive the base from the allocated invoices because a
payment often covers parts of invoices, advances, or VAT-free amounts, and the accountant decides
what is subject. Each payment stores the category, rate, base and tax, so the quarterly report
reads them back without recomputing.

Withholding is EGP only; foreign suppliers are outside the Egyptian scheme. The three seeded
categories (supplies 1%, services and contracting 3%, commissions and professional fees 5%) and the
report layout are to be confirmed by the accountant before release.
