# Manager+

Working codename for an Arabic/English desktop POS, stock and accounting app for small shops in Egypt. See `CLAUDE.md`.

Proprietary. All rights reserved.

## Building

- `npm ci`, then `npm run dev` for the app with live screens (Tauri, needs Rust and WebView2 or WebKitGTK).
- `npm run check` for the screens' types, lint and tests; `cargo test --workspace` for the Rust core.
- `npx tauri build` for the Windows installer (`target/release/bundle/nsis/`).
- `npm run e2e` drives a debug build (`npx tauri build --debug --no-bundle`) with tauri-driver.
