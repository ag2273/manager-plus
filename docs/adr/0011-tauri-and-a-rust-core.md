# 11. Tauri, with the core in Rust

Status: accepted (#72), done (#81)

## Context

A small footprint is one of the product's features: the app must be light on memory and disk on the modest PCs small shops run. The Electron build ships its own Chromium and Node: the installer is about 130 MB and a running app takes a few hundred MB of memory before any work. The screens are React and must keep handling Arabic right to left, text shaping and mixed Arabic and English well.

## Decision

- **Tauri 2 shell.** The app is a Rust binary that shows the screens in the WebView Windows already has (WebView2). No browser or Node ships with it.
- **The core in Rust.** `crates/core` (`manager-core`) is the `Business` facade, ported slice by slice from the TypeScript core (#73 to #81), which is now gone. It kept every rule of the TypeScript core: one transaction per command, integer piastres and thousandths, the ledger and stock movements as the only truth, the same refusal codes.
- **The same file format.** The Rust core makes and reads the same `.mplus` files. Each migration's SQL is the TypeScript one byte for byte (`crates/core/migrations/`); the rows a migration adds are written in Rust. Tests check that a new file's schema equals the one the TypeScript core made, and that a file it made opens, signs in and keeps its books. Passwords use the same scrypt parameters and stored format.
- **Screens unchanged.** The React screens stay. The renderer talks to the shell through one Tauri command, `desktop(channel, args)`, that keeps the Electron preload's API (`DesktopApi` in `shared/api.ts`). Facade calls go through `Business::call(method, args)` with JSON arguments.
- **Why not native Rust screens.** Rust UI toolkits are still weak at Arabic shaping, bidirectional text and right-to-left layout; the WebView does these well and costs little because Windows already has it.
- **Receipt printing.** The screens draw the receipt on a canvas from the same `PrintDocument` the Electron app prints (the webview may not read back the pixels of an HTML page drawn as an image, and a canvas shapes Arabic itself), and turn it into an ESC/POS raster with `shared/escpos.ts`. Rust only sends the bytes: to a network printer's port, or to a Windows printer as a RAW spooler job. RAW suits every 80 mm ESC/POS receipt printer and opens a cash drawer wired to it; a printer that only takes its driver's page language (not ESC/POS) is not supported.
- **The screens' contract.** The types the screens use for the core's answers and arguments (`src/shared/books/*.d.ts`) are the TypeScript core's declarations, kept as types only. A change to a facade method's shape in Rust changes its declaration there by hand.
- **Tests.** The Rust core is tested through the facade. The printed and exported documents are made from the Rust core's real answers: `crates/core/tests/screen_fixtures.rs` keeps them as JSON fixtures in `src/shared/__fixtures__/books/`, and the screens' tests render those against the golden files. WebDriver journeys (tauri-driver) drive the built app on Linux in CI: the books (`e2e/tauri.mjs`) and a till checkout in Arabic and in English (`e2e/checkout.mjs`). The Windows CI job runs clippy and the tests there (the Windows-only code), builds the NSIS installer and records its size and the running app's memory.

## Consequences

- Electron and the TypeScript core are removed (#81). The first start of the Tauri app takes over the Electron app's licence, preferences, recent files, known servers and server certificate from `%APPDATA%\Manager+`, so nothing is activated or paired again.
- E-invoice secrets sealed by Electron's `safeStorage` can't be unsealed with plain DPAPI; they are typed in once more.
- Memory depends on WebView2, which Windows shares between apps; the Windows CI job is where it is measured.
- Each slice ported its tests from the TypeScript ones, so the Rust core answers as the TypeScript one did.
