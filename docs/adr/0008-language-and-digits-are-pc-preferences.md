# Language and digits are preferences of each PC

The screen language, the document language and the digit style are kept in the PC's preferences file, next to the theme and the receipt printer, not in the business file.

- **Why per PC:** a shop can have an Arabic-speaking cashier on the till and an English-speaking accountant on the office PC, working on the same file through the server. Each sees their own language; neither changes the other's.
- **Two languages, not one:** a shop that works in Arabic often sells to companies that want English invoices (importers, B2B buyers), and the other way round. The screen language and the document language are separate settings.
- **Digits are display only:** amounts and quantities are stored as integers and formatted at the edge (`shared/money.ts`, `shared/quantity.ts`). Every input accepts both digit styles. Excel exports keep numbers as numbers, so Excel shows them in its own format.
- **Item names:** English documents use the item's English name when it has one, and its Arabic name otherwise.
