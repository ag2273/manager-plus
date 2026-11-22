# 1. One SQLite file per business, marked and versioned inside the file

Date: 2026-11-20 · Status: accepted

Each business is a single SQLite file with the `.mplus` extension. The file marks itself as ours with SQLite's `application_id` header field (`0x4D504C53`, "MPLS"), and records its schema version in `user_version`.

- Opening checks `application_id` first, so any other file (a text file, another app's database) is refused with `not_a_business_file` instead of being migrated.
- Migrations are forward-only and run in one transaction on open; a file whose `user_version` is newer than the app knows is refused with `made_by_newer_version` and left untouched.
- Files use WAL journal mode and foreign keys on.
- The Rust core uses rusqlite with SQLite bundled (ADR 0011); the file is the same one the TypeScript core with better-sqlite3 wrote.
