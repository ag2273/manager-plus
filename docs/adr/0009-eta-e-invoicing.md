# E-invoicing with the ETA: optional, queued, signed through Windows

E-invoicing is a setting each business turns on; it is off by default and nothing else depends on it.

- **Posting never waits.** Posting a sales invoice or credit note only adds it to a queue (`eta_documents`) in the same transaction. The PC that holds the file signs and sends the queue in the background: after each posting and every five minutes. A document that can't be prepared (an item without an EGS/GS1 code, a customer without a tax number or address), can't be signed, or that the ETA refuses is marked *failed* with the reason; the owner fixes it and sends it again. When the ETA can't be reached, documents stay *pending*.
- **What goes:** sales invoices (type I) and credit notes (type C) to company customers (receiver type B). A credit note goes once its invoice is *valid*, referring to the invoice's UUID. Till receipts are a separate ETA system (e-receipts) and are not sent here.
- **Signature:** a detached CAdES-BES signature (CMS SignedData with the signing-certificate-v2 attribute) over the ETA's canonical form of the document, built in `crates/core/src/eta/cades.rs`. Only the RSA-SHA256 signature over the signed attributes is asked of the token.
- **The token:** Egyptian signing tokens install a Windows driver that puts their certificate in the user's certificate store. The app signs through Windows (PowerShell and .NET's RSA key of that certificate), and the driver asks for the PIN. This avoids a native PKCS#11 module. If a token is found that only offers PKCS#11, a PKCS#11 signer can be added behind the same `Signer` interface.
- **Credentials:** the client secret is sealed with Windows DPAPI on the PC that saves it, and stored sealed in the business file. On another PC, or for another Windows user, it has to be typed in again.
- **Tax subtypes:** standard-rated lines go as T1/V009, zero-rated as T1/V001 (exports), exempt as T1/V003. To be confirmed by the accountant and in pre-production.
- **Testing:** the ETA client is injected, so the tests use a fake ETA. Before release, the whole flow must be run against the ETA pre-production environment with the business's own test credentials and token.

## E-receipts (#36)

Till sales and returns go to the ETA's e-receipt API (v1.2), switched on separately once e-invoicing is on, with the POS's own registration (serial, OS, model, client ID and secret, pre-shared key). The secret and key are sealed on the PC that holds the file, like the invoicing secret.

- A receipt is issued when it is posted, in the same transaction: it gets its UUID (SHA-256 of its canonical form with an empty UUID) and names the last receipt this POS issued (`eta_settings.pos_last_uuid`). So the printed receipt carries its QR code even with no internet, and sales made offline go later, in order, as the same receipts.
- E-receipts are not signed with the token; the POS signs in with its own credentials.
- A receipt that can't be issued (an item without an EGS/GS1 code) is marked failed and the sale still stands. Once fixed and sent again, and likewise for one the ETA refused or found invalid, it is issued anew at the end of the chain; a batch is sent in chain order.
- A return goes only if its sale was an e-receipt, and points to it (`referenceOldUUID`).
- The QR holds the ETA's public link for the receipt with its time, total and the seller's tax number.

Still to confirm against pre-production: the exact receipt-details endpoint and response shape, and whether the ETA accepts a receipt sent again under the same receipt number.
