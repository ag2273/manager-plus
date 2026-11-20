# 2. Several PCs share a business through one server PC, never through a shared folder

Date: 2026-11-20 · Status: accepted

A shop or company with more than one PC picks one of them as the **server**. That PC opens the business file as usual and also serves the `Business` facade over the office network. The other PCs run as **clients**: they never touch the file, they send each command and query to the server and show the result. A single-PC shop is simply a server with no clients.

## Why not open the file from a shared folder

SQLite over SMB/Windows file sharing is the classic way to lose data: file locks over the network are unreliable, WAL mode does not work across machines at all, and a laptop that sleeps mid-write can leave the file corrupt. With one server process there is exactly one writer, better-sqlite3 runs every command to completion before the next starts, and every command is already one transaction. Two clients posting at the same moment are served one after the other and both succeed.

## How it works

- **Transport.** TLS over TCP (default port 47100), carrying newline-delimited JSON requests and replies. A request is `hello`, `signIn`, `resume`, `signOut` or `call` with a method name and arguments.
- **Same allow-list.** `call` accepts only the `BUSINESS_METHODS` the local screens may call; the server checks it, and the facade checks the user's role on every call as it does locally. Nothing else in the main process (files, printers, dialogs) is reachable from the network.
- **Sign-in on the server.** Users sign in against the server's users. A successful sign-in returns a random session token held only in the server's memory; a client that loses its connection resumes with the token instead of the password. Restarting the server signs everyone out.
- **Encryption and identity.** On first start the server makes a self-signed certificate (P-256, ten years) and keeps it with the app's data, so its identity survives restarts. There is no certificate authority on a shop's network, so clients use trust on first use: the first connection records the certificate's SHA-256 fingerprint, and every later connection must present the same one or is refused with `server_identity_changed`. The server's settings show a short form of the fingerprint so a careful owner can compare it on the client.
- **Finding the server.** The server announces itself with mDNS (`_managerplus._tcp.local`), so clients list servers on the same network without typing anything; an address and port can also be typed for networks that block multicast.
- **No offline writes.** When the server is off or unreachable a client shows a clear Arabic message and retries on the next action. Clients never queue writes to replay later, because a sale replayed after someone else's edit would break the gap-free numbering and stock order.

## Consequences

- The server PC must be on for anyone to work. That is the same constraint a shared-folder setup has, without the corruption risk.
- Windows asks to allow the app through the firewall the first time it listens; the installer (#22) adds an inbound rule for the server port so the prompt does not appear on a shop PC with no administrator present.
- Receipts and A4 documents are printed by the PC that asks for them, using data fetched from the server.
