# Manager+ (working codename)

Offline Windows desktop app for small Egyptian retail and trading shops: point of sale, stock, and double-entry accounting, in Arabic (RTL, default) and English. Single user. Stack: Electron + TypeScript + React + SQLite (better-sqlite3).

- Product spec (PRD): https://claude.ai/artifact/QFarCgLGUwmnozykFaz1yw
- Work is tracked as GitHub issues in this repo, one tracer-bullet slice per issue.

## How we work

We use Matt Pocock's engineering skills (vendored in `.claude/skills`, MIT, from github.com/mattpocock/skills): grilling → to-spec → to-tickets → implement with tdd → code-review.

## Engineering rules

- The ledger and stock movements are the single source of truth. Every balance, quantity and report is derived from them; never store an editable balance.
- All business rules live in the core module, behind one `Business` facade (commands + queries). UI code never computes money, tax or stock.
- Money is integer piastres (1/100 EGP). Quantities are integer thousandths of the base unit. No floating-point amounts.
- Every command writes all its rows in one database transaction, or nothing. Debits must equal credits.
- Tests go through the `Business` facade on an in-memory SQLite database. No tests against tables or private functions.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created as terms and decisions are settled. See `docs/agents/domain.md`.
