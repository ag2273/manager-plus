# 11. Tauri, with the core in Rust

Status: accepted (#72)

## Context

A small footprint is one of the product's features: the app must be light on memory and disk on the modest PCs small shops run. The Electron build ships its own Chromium and Node: the installer is about 130 MB and a running app takes a few hundred MB of memory before any work. The screens are React and must keep handling Arabic right to left, text shaping and mixed Arabic and English well.

## Decision

- **Tauri 2 shell.** The app is a Rust binary that shows the screens in the WebView Windows already has (WebView2). No browser or Node ships with it.
- **The core in Rust.** `crates/core` (`manager-core`) is the `Business` facade, ported slice by slice from `src/core` (#73 to #81). It keeps every rule of the TypeScript core: one transaction per command, integer piastres and thousandths, the ledger and stock movements as the only truth, the same refusal codes.
- **The same file format.** The Rust core makes and reads the same `.mplus` files. Each migration's SQL is the TypeScript one byte for byte (`crates/core/migrations/`); the rows a migration adds are written in Rust. Tests check that a new file's schema equals the one the TypeScript core makes, and that a file the TypeScript core made opens, signs in and keeps its books. Passwords use the same scrypt parameters and stored format.
- **Screens unchanged.** The React screens stay. The renderer talks to the shell through one Tauri command, `desktop(channel, args)`, that mirrors the Electron preload's API, so a screen doesn't know which shell it runs in. Facade calls go through `Business::call(method, args)` with JSON arguments; a method not ported yet answers `not_ported`.
- **Why not native Rust screens.** Rust UI toolkits are still weak at Arabic shaping, bidirectional text and right-to-left layout; the WebView does these well and costs little because Windows already has it.
- **Receipt printing.** The screens draw the receipt on a canvas from the same `PrintDocument` the Electron app prints (the webview may not read back the pixels of an HTML page drawn as an image, and a canvas shapes Arabic itself), and turn it into an ESC/POS raster with `shared/escpos.ts`. Rust only sends the bytes: to a network printer's port, or to a Windows printer as a RAW spooler job. RAW suits every 80 mm ESC/POS receipt printer and opens a cash drawer wired to it; a printer that only takes its driver's page language (not ESC/POS) is not supported.
- **Tests.** The Rust core is tested through the facade, as the TypeScript one is. A WebDriver journey (`e2e/tauri.mjs`, tauri-driver) drives the built app on Linux in CI. The Windows CI job builds the NSIS installer and records its size and the running app's memory.

## Consequences

- Electron and the TypeScript core stay until every slice is ported (#81 removes them); until then both apps build.
- Memory depends on WebView2, which Windows shares between apps; the Windows CI job is where it is measured.
- Each slice ports its tests from the TypeScript ones, so both cores answer the same way while both exist.
