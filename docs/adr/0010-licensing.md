# 10. Licensing: offline-checked signed licence, trial and read-only mode

Status: accepted (#20)

## Context

Manager+ is sold as a one-time licence per company with a yearly support plan, and a mid-size company runs one server PC with several client PCs. Shops are often offline, so a licence can't depend on a server being reachable at every start, and there is no code-signing or DRM budget.

## Decision

- **Trial.** A new install runs a full 14-day trial from the first business file. The start is the earliest of the saved trial start and the oldest record in any file opened, so deleting the app's data doesn't start a new trial. The latest time seen is saved; a clock more than 26 hours behind it counts as turned back and the app goes read-only until the clock is right.
- **Licence file.** Activation sends the key and the PC's fingerprint to the licence server (#21) once; it returns a licence file: a JSON payload (company, fingerprint, number of users, support end date) and its Ed25519 signature. The app checks it offline at every start with the public key built into the app (`core/licence/public-key.ts`); the private key exists only as a licence-server secret.
- **Fingerprint.** Windows's MachineGuid, hashed with an app prefix. It is stable across reboots and hardware changes and changes on a Windows reinstall, which counts as a move. The server allows two moves a year.
- **Enforcement in the core.** The PC that holds the file applies the licence to the `Business` facade (`setLicenceLimits`). Read-only refuses every command with `read_only` except backups, passwords and sending already-posted documents to the ETA; all queries, printing and exports keep working. Signing in beyond the licensed number of people at once is refused with `licence_users_exceeded`; the same person twice counts once. On the server, a client PC that dropped off without signing out gives up its seat when one is needed.
- **Updates.** An update released after the support end date is not offered; the installed version keeps working (#22 uses `Licensing.updateAllowed`).
- **Injected client.** The licence server is an injected `LicenceClient`, so tests use a fake.

## Consequences

- Determined users can still patch the app; the aim is to keep honest customers honest, not DRM.
- The public key in the repo is a placeholder until the licence server is deployed; no licence verifies until then.

## The licence server (#21)

A Cloudflare Worker with a D1 database (`licence-server/`). It keeps only each key's SHA-256 and last four characters; a key is shown once when made. Activation on another PC ends the old activation and counts as a move, at most two in any 12 months; the admin can reset that. Revoking stops a key from activating, but a PC that already has its licence file keeps working offline, as any offline licence does. The signing key is a Worker secret, piped straight from `make-keys.mjs` into `wrangler secret put`, so it never touches the repo or a disk. Activation is rate-limited per IP address in D1. The admin page sits behind HTTP Basic auth, compares the password in constant time and limits wrong guesses.

## Installer and updates (#22)

- **Installer.** An unsigned NSIS installer for Windows x64 is built by electron-builder in CI (`npm run dist`) and kept as a build artifact. It is per-user, Arabic first, and never deletes business files on uninstall. `docs/install/` walks through the one SmartScreen step ("More info → Run anyway").
- **Signed manifest.** Each release has a manifest: version, release date, installer URL, SHA-256, size, and notes in both languages. It is signed with a release key separate from the licence key. The private key stays on the owner's PC (`scripts/release.mjs keygen` / `sign`); the app carries the public key (`core/update-key.ts`).
- **Serving and checking.** The licence Worker only stores and serves the newest signed manifest (`/v1/update`), so a compromised server can't push an update. The app rejects an unsigned or tampered manifest, and an installer whose hash or size differ.
- **Eligibility.** An update is offered only if released on or before the licence's support end date (`Licensing.updateAllowed`). During the trial updates are offered; read-only installs none. The installed version keeps working regardless.
- **Installing.** A manager starts it. The app downloads and verifies the installer, backs up the business file this PC holds (to the backup folder, or beside the file), then runs the installer silently and restarts.
