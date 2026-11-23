import type { HelpContent } from "./types";

/** The built-in help in English (#97, note 11). */
export const helpEn: HelpContent = {
  manualTitle: "User guide",
  manualIntro:
    "All the help in one place, without the internet: what each screen is for, the steps of each task from start to finish, and how the app handles accounts, stock and tax.",
  searchLabel: "Search the guide",
  searchHint: "Type a word, such as: return, shift, opening balances",
  noResults: "Nothing found. Try another word.",
  sections: { screens: "Screens", guides: "Step by step", concepts: "How the app works", fields: "Fields" },
  screenHelp: "Help for this screen (F1)",
  openManual: "Open the user guide",
  close: "Close",
  goTo: "Go to the screen",
  fieldHelp: (label) => `What is “${label}”?`,

  fieldNames: {
    businessName: "Business name",
    taxRegistrationNumber: "Tax registration number",
    fiscalYearStart: "Fiscal year start",
    itemBarcode: "Barcode",
    itemSalePrice: "Sale price",
    itemTaxCode: "Tax type",
    itemPack: "Selling by the pack",
    itemEgsCode: "EGS / GS1 code",
    itemSerials: "Serialised item",
    purchaseReference: "Supplier's invoice number",
    purchaseRate: "Exchange rate",
    shiftFloat: "Float",
    tillPaidNow: "Paid now",
    returnRefund: "Refund method",
    shiftCounted: "Cash counted",
    customerTaxNumber: "Customer's tax registration number",
    customerCreditLimit: "Credit limit",
    openingBalance: "Opening balance",
    lockDate: "Lock date",
  },

  fields: {
    businessName: "The name on receipts, invoices and reports. You can change it later in Settings.",
    taxRegistrationNumber:
      "The business's VAT registration number (9 digits). With it, the app treats the business as registered: it charges VAT on sales and purchases and shows the VAT return. Leave it empty if the business is not registered.",
    fiscalYearStart: "The month your financial year starts, usually January. Yearly reports and the year end follow it.",
    itemBarcode:
      "The number printed on the item. Scan it into this field with the barcode reader, and the item comes up at once at the till. No two items share a barcode.",
    itemSalePrice:
      "The price of one unit to the customer with VAT included, the price they actually pay. The app works out the VAT inside it.",
    itemTaxCode:
      "Standard: VAT at the general rate. Zero: taxable at zero, such as some exports. Exempt: no VAT, such as some basic goods. Ask your accountant if you are not sure.",
    itemPack:
      "If you also sell the item by the carton or box, give its name, how many units it holds, its barcode and its price. Stock is still kept in the base unit.",
    itemEgsCode: "The item's code in the Tax Authority's e-invoice system. Needed only when the e-invoice link is on.",
    itemSerials:
      "For devices where every unit has its own serial number (laptops, routers, phones). Each unit's serial is asked for when buying, selling and taking it back, so you know where each unit is, who bought it and its warranty.",
    purchaseReference: "The invoice number as printed on the supplier's paper invoice, to find it again when checking or returning goods.",
    purchaseRate:
      "How many pounds one unit of the supplier's currency is worth on the invoice date, such as 50.25 for the dollar. The invoice goes into the books in pounds at this rate.",
    shiftFloat: "The cash in the drawer when the shift starts (the change). It counts toward the cash expected when the shift closes.",
    tillPaidNow: "What the customer pays now. If it is less than the total, the rest goes on the chosen customer's account.",
    returnRefund:
      "Cash from the drawer: the customer gets the money now, from the shift. To the customer's account: the amount comes off what they owe, or stays as credit for them.",
    shiftCounted:
      "Count the cash actually in the drawer and enter it. The app compares it with what is expected and records the difference as over or short on the Z report.",
    customerTaxNumber:
      "A company customer's tax registration number. It is printed on their invoice and needed to send the e-invoice to the Tax Authority.",
    customerCreditLimit:
      "The most the customer may owe on account. When an invoice or sale goes past it, a manager has to approve with their name and password, and the approval is kept in the audit log.",
    openingBalance:
      "The account's balance on the day you start using the app, as in your old books or in fact. The difference between debits and credits goes to the opening balances account by itself.",
    lockDate:
      "The app takes no entry or document dated on or before this day, so the periods you closed stay as you checked and filed them.",
  },

  screens: {
    home: {
      title: "Home",
      purpose: "Today at a glance: sales, gross profit, the cash expected in the drawer and items below their minimum, and the first steps for a new file.",
      points: [
        "A new file shows the first steps in order. Sales and purchases stay closed until a manager confirms the opening balances, or says the business is new.",
        "The figures come from the entries and stock movements, so they change with every sale or purchase.",
        "Click any box to go to its screen.",
      ],
      guides: ["firstDay", "openingBalances"],
    },
    till: {
      title: "Till",
      purpose: "Selling to customers by barcode, paid in cash, by card, by wallet or on account, with the receipt printed.",
      points: [
        "Open a shift first, with the float in the drawer.",
        "Scan the barcode, or type the item's name and press Enter. Scan again to add one more.",
        "Keys: F2 search, F4 discount, F6 past sales, F8 hold the sale, F9 return, F12 payment, Enter complete the sale, Esc clear, F10 close the shift.",
        "An item with serials is scanned by the unit's own serial, not the item's barcode.",
        "Past sales (F6) lists today's or any period's receipts, prints any of them again, and lets a manager turn one into a tax invoice for a company customer.",
      ],
      guides: ["sellAtTill", "returnAtTill", "closeShift", "receiptToInvoice"],
    },
    items: {
      title: "Items and stock",
      purpose: "The items with their prices, barcodes and tax type, added one by one or from an Excel file.",
      points: [
        "“+ New item” opens the item form. The price is entered with VAT included.",
        "Importing from Excel adds items, their opening stock and customer and supplier balances at once, and saves nothing unless every row is sound.",
        "“Find a serial” shows any unit's history: where it was bought, who it was sold to, and its warranty.",
        "“Item serials in stock” lists every unit of an item on hand and the warehouse each one is in.",
      ],
      guides: ["openingBalances", "buyIn"],
    },
    warehouses: {
      title: "Warehouses and transfers",
      purpose: "Warehouses at one site, moving goods between them, stock counts, write-offs, low stock, and each item's movements.",
      points: [
        "A transfer moves the quantity from one warehouse to another at its cost, without changing the total stock value.",
        "Stock count: enter the quantity you found on the shelf; the difference from the books is booked as a count gain or loss at average cost.",
        "Write-off, for damaged or expired goods: takes them out of stock and books the loss.",
        "Low stock: the items below the minimum you set for them, so you know what to buy.",
      ],
      guides: ["stockCount"],
    },
    purchases: {
      title: "Purchases and suppliers",
      purpose: "Supplier invoices, returns to suppliers, import shipments, supplier details, payments to them, and their statements.",
      points: [
        "Prices on a purchase invoice are before VAT. Posting adds to the stock and to the supplier's balance together.",
        "A foreign supplier's invoice is in their currency with an exchange rate, and has no VAT; import VAT is paid at customs.",
        "In “Past invoices”: “Details” shows the invoice's lines and serials, and “Return to supplier” records a debit note.",
        "An import shipment gathers the supplier's invoices with customs, freight and clearing, and spreads those costs over the items, raising their cost.",
      ],
      guides: ["buyIn", "paySupplier"],
    },
    customers: {
      title: "Customers",
      purpose: "Customer details and balances, receipts of payment from them, their statements, and the age of what they owe.",
      points: [
        "Each customer has an optional credit limit and a price level (retail or wholesale).",
        "A receipt records what they paid, and can be split over particular invoices; otherwise it settles the oldest first.",
        "The statement shows every movement and the balance after each.",
      ],
      guides: ["collectFromCustomer"],
    },
    salesInvoices: {
      title: "Sales invoices",
      purpose: "A4 tax invoices for company and credit customers at prices before VAT, credit notes against them, and quotations.",
      points: [
        "An invoice goes on the customer's account and takes the goods out of the chosen warehouse.",
        "A quotation changes nothing in the books until it becomes an invoice.",
        "A credit note takes back part or all of an invoice at its prices and VAT.",
        "When the e-invoice link is on, invoices and credit notes go to the Tax Authority by themselves.",
      ],
      guides: ["invoiceCompany", "receiptToInvoice"],
    },
    money: {
      title: "Cash and banks",
      purpose: "Cash, bank and wallet balances, expenses, transfers between them, bank reconciliation, and locking a period.",
      points: [
        "An expense is paid from a cash or bank account to an expense account (rent, electricity, salaries…).",
        "A transfer moves money between cash, a bank or a wallet.",
        "Bank reconciliation matches the bank's balance in the books with the bank statement.",
        "Locking a period stops any change dated in it once it has been checked.",
      ],
      guides: ["closePeriod"],
    },
    reports: {
      title: "Reports",
      purpose: "Profit and loss, the balance sheet, the ledger, sales by item, day and payment method, stock value, and the VAT return.",
      points: [
        "Every figure comes from the entries: click an account to see its ledger, then a line to see the whole entry.",
        "Each report prints, saves as PDF or exports to Excel, in Arabic or English.",
      ],
      guides: ["closePeriod"],
    },
    accounts: {
      title: "Accounts",
      purpose: "The chart of accounts, manual journal entries, opening balances, the trial balance, and withholding tax categories.",
      points: [
        "Accounts marked “Automatic” are used by the app itself (sales, VAT, stock…) and cannot be deleted.",
        "A manual entry must balance, debits equal to credits, before it is posted.",
        "A posted entry is never deleted; it is voided by a reversing entry that stays on record.",
      ],
      guides: ["openingBalances"],
    },
    users: {
      title: "Users",
      purpose: "The people who use the app: each has a sign-in name, a password and a role that decides what they see and do.",
      points: [
        "Manager: everything. Accountant: the books, reports, customers and suppliers. Cashier: the till and customers. Storekeeper: items, warehouses and purchases.",
        "The app itself refuses each role what is not theirs, even from another PC on the network.",
      ],
      guides: ["firstDay"],
    },
    audit: {
      title: "Audit log",
      purpose: "Every command carried out in the app: who did it, when, and what changed. The log cannot be edited or deleted.",
      points: ["Each line gives the time, the user and the action, so you know who recorded a document, changed details or approved going past a credit limit."],
      guides: [],
    },
    settings: {
      title: "Settings",
      purpose: "Appearance and language, backups, the receipt printer, working over the network, e-invoice and e-receipt, the licence, and updates.",
      points: [
        "The screen language and the printed documents' language are set apart, and so is the style of digits.",
        "Backups are made every day by themselves in the folder you choose, keeping the last 30, and one before every update.",
        "Printer: an 80 mm thermal printer on USB or the network, with the cash drawer.",
        "Network: one PC holds the file (the server) and the other PCs in the shop connect to it.",
      ],
      guides: ["firstDay", "backupRestore"],
    },
  },

  guides: [
    {
      id: "firstDay",
      title: "Your first day with the app",
      summary: "From creating the business to the first sale.",
      steps: [
        { text: "Create the business on the welcome screen: its name, your name and password, and where to save the file." },
        { text: "Check the business details, tax registration number and fiscal year start.", screen: "settings" },
        { text: "Add any other warehouses; the main warehouse is there from the start.", screen: "warehouses" },
        { text: "Add the items with their prices and barcodes, or import them from Excel.", screen: "items" },
        { text: "Enter the opening balances (see “Entering opening balances”).", screen: "home" },
        { text: "Set up the receipt printer and choose the backup folder.", screen: "settings" },
        { text: "Add users for cashiers or an accountant, if any.", screen: "users" },
        { text: "On Home, confirm the opening balances; sales and purchases open.", screen: "home" },
      ],
    },
    {
      id: "openingBalances",
      title: "Entering opening balances",
      summary: "What you have on day one: stock, cash, banks, what customers owe and what you owe suppliers.",
      steps: [
        { text: "Pick the start date, the first day you use the app." },
        { text: "Fill the import template with the items, their quantities and cost, and customer and supplier balances, then import it.", screen: "items" },
        { text: "Or enter account balances (cash, bank…) under “Opening balances”.", screen: "accounts" },
        { text: "Check the trial balance: it must match your old books or the facts.", screen: "accounts" },
        { text: "On Home, click “Confirm the opening balances and start”. For a new business with nothing to bring forward, choose that instead.", screen: "home" },
        { text: "A mistake found later is corrected with a journal entry, not by deleting balances." },
      ],
    },
    {
      id: "buyIn",
      title: "Buying from a supplier into the warehouse",
      summary: "A supplier's invoice adds to the stock and to the supplier's balance together.",
      steps: [
        { text: "Add the supplier if they are new, in their currency if they are abroad.", screen: "purchases" },
        { text: "In “Purchase invoice”, choose the supplier and the warehouse, and enter their invoice number.", screen: "purchases" },
        { text: "Add the items with quantities and prices before VAT. For a serialised item, enter each unit's serial." },
        { text: "Check the total and VAT, then post. The quantity goes up in the warehouse and the average cost is updated." },
        { text: "If goods go back to the supplier, record it from “Past invoices” then “Return to supplier”.", screen: "purchases" },
      ],
    },
    {
      id: "sellAtTill",
      title: "Selling at the till",
      summary: "From opening the shift to printing the receipt.",
      steps: [
        { text: "Open a shift and enter the float.", screen: "till" },
        { text: "Scan the items or search for them by name (F2)." },
        { text: "Press F4 for a discount. Press F8 to hold the sale and serve another customer." },
        { text: "Press F12 and choose how they pay: cash, card, wallet, split, or on a customer's account." },
        { text: "Press Enter to complete the sale. The receipt prints and the drawer opens, if they are set up." },
      ],
    },
    {
      id: "returnAtTill",
      title: "A customer's return at the till",
      summary: "Goods come back at the sale's own price, VAT and cost.",
      steps: [
        { text: "On the till, press F9.", screen: "till" },
        { text: "Enter the original receipt number and search." },
        { text: "Enter how much of each item comes back, and the unit's serial for a serialised item." },
        { text: "Refund in cash from the drawer or to the customer's account, then record the return." },
      ],
    },
    {
      id: "closeShift",
      title: "Closing the shift and the Z report",
      summary: "Matching the cash in the drawer with what should be there.",
      steps: [
        { text: "On the till, press F10.", screen: "till" },
        { text: "Count the cash in the drawer and enter the amount." },
        { text: "Click “Close and print the Z report”. It shows sales by payment method, returns, cash paid out of the drawer, and any over or short." },
        { text: "The difference is booked by itself, so do not adjust it by hand." },
      ],
    },
    {
      id: "receiptToInvoice",
      title: "Turning a till receipt into a tax invoice",
      summary: "For a company customer who asks for a tax invoice after buying at the till.",
      steps: [
        { text: "Add the customer with their tax registration number if they are new.", screen: "customers" },
        { text: "On the till, press F6 and open the receipt.", screen: "till" },
        { text: "Click “Turn into a tax invoice” (a manager, from an open shift), and choose the customer." },
        { text: "The receipt is cancelled by a full return to the customer's account, and an invoice for the same items and amounts is issued, settled by that return. Sales, VAT and cash do not change." },
        { text: "Print the invoice from Sales invoices.", screen: "salesInvoices" },
      ],
    },
    {
      id: "invoiceCompany",
      title: "A credit invoice for a company customer",
      summary: "From quotation to invoice to collection.",
      steps: [
        { text: "Write a quotation if the customer asks for one, and turn it into an invoice when they agree.", screen: "salesInvoices" },
        { text: "Or write the invoice directly: the customer, the warehouse, and the items at prices before VAT.", screen: "salesInvoices" },
        { text: "If the customer goes past their credit limit, a manager has to approve." },
        { text: "When they pay, record a receipt and put it against the invoice.", screen: "customers" },
      ],
    },
    {
      id: "collectFromCustomer",
      title: "Collecting from a customer",
      summary: "A receipt lowers what they owe.",
      steps: [
        { text: "On Customers, open “Receipt” and choose the customer and the account the money went into.", screen: "customers" },
        { text: "Enter the amount, and split it over open invoices if you like; otherwise it settles the oldest first." },
        { text: "If the customer withheld tax, choose its category so it is booked in your favour." },
      ],
    },
    {
      id: "paySupplier",
      title: "Paying a supplier",
      summary: "A supplier payment lowers what you owe them.",
      steps: [
        { text: "On Purchases, open “Payment” and choose the supplier and the account the money came from.", screen: "purchases" },
        { text: "Enter the amount in the supplier's currency, and split it over their invoices if you like." },
        { text: "If you withhold tax, choose its category; the supplier is settled in full and the cash pays the net." },
      ],
    },
    {
      id: "stockCount",
      title: "Counting a warehouse",
      summary: "Matching what is on the shelf with what is in the books.",
      steps: [
        { text: "Open “Stock count” and choose the warehouse.", screen: "warehouses" },
        { text: "Enter the actual quantity of each item you count." },
        { text: "Post the count. More than the books is a count gain, less is a count loss, at average cost." },
      ],
    },
    {
      id: "closePeriod",
      title: "Checking and closing the month",
      summary: "Before filing the VAT return.",
      steps: [
        { text: "Check the trial balance and the profit and loss for the month.", screen: "reports" },
        { text: "Match the banks under “Bank reconciliation”.", screen: "money" },
        { text: "Print or export the VAT return, and click any line to see its documents.", screen: "reports" },
        { text: "Lock the period up to the month's last day, so nobody records anything back-dated.", screen: "money" },
      ],
    },
    {
      id: "backupRestore",
      title: "Backups and restoring",
      summary: "Keeping your data safe from a broken PC.",
      steps: [
        { text: "Choose the backup folder: a USB stick or a OneDrive folder.", screen: "settings" },
        { text: "A backup is made every day by itself, keeping the last 30. You can also make one now at any time." },
        { text: "To restore, choose the backup; the app backs up the current file first, then restores, and asks you to sign in again." },
      ],
    },
  ],

  concepts: [
    {
      id: "ledger",
      title: "The entries come first",
      paragraphs: [
        "Every sale, purchase, return or payment writes a double entry in the journal: debits equal to credits. No balance is kept apart; every balance and every report is worked out from the entries.",
        "So the balance sheet can never disagree with the ledger, and from any figure in a report you can always reach the entries behind it.",
        "A posted entry is never deleted. A mistake is corrected by a reversing entry, so the whole trail stays on record.",
      ],
    },
    {
      id: "stock",
      title: "Stock and cost",
      paragraphs: [
        "The quantity in each warehouse comes from the stock movements: purchases, sales, returns, transfers, counts and write-offs.",
        "Cost is the weighted average: each purchase works out the unit's average cost again, and each sale takes the quantity out at that average into the cost of goods sold. So gross profit is right with every sale.",
        "That is why opening stock must be in before selling: selling first takes the quantity below zero and spoils cost and profit.",
      ],
    },
    {
      id: "vat",
      title: "Value added tax",
      paragraphs: [
        "Till prices include VAT, and the app works out the VAT inside them. Sales and purchase invoice prices are before VAT, and VAT is added on top.",
        "VAT on sales goes to output VAT, VAT on purchases to input VAT, and the difference is what you pay on the return.",
        "Import VAT paid at customs is input VAT; the other import costs raise the items' cost.",
        "A business with no tax registration number charges no VAT and has no return.",
      ],
    },
    {
      id: "parties",
      title: "Customers and suppliers",
      paragraphs: [
        "A customer's or supplier's balance is what the receivables or payables account holds in their name. An invoice raises it; a payment or a return lowers it.",
        "A payment can be put against particular invoices; what is not settles the oldest first in the aging report.",
        "A foreign supplier has a balance in their currency, valued in pounds in the books, and exchange differences are booked by themselves when you pay.",
      ],
    },
    {
      id: "eta",
      title: "The Tax Authority link",
      paragraphs: [
        "The link is optional for each business, and turned on in Settings.",
        "E-invoice: sales invoices and credit notes to company customers are signed with the token certificate and sent to the Authority by themselves.",
        "E-receipt: till receipts and their returns go to the Authority, and a QR code prints on the receipt.",
        "The books never wait for the Authority: with the internet down, the document is kept and sent when it is back, and its state shows in the sending list.",
      ],
    },
    {
      id: "network",
      title: "More than one PC in the shop",
      paragraphs: [
        "The business file is on one PC, the server. The other PCs in the shop connect to it over the local network, with no internet or cloud.",
        "Each user signs in with their own name, has the rights of their role, and everything they do is kept in the audit log.",
        "The licence is activated on the server, and the other PCs use it.",
      ],
    },
  ],
};
