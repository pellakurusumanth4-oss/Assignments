# Transaction Ledger API

A backend API for a simple transaction ledger: create accounts, post credits and debits, read balances and paginated transaction history, and move money between accounts atomically.

**Stack:** Node.js + TypeScript, Express 5, PostgreSQL, Zod for validation, Swagger UI for docs.
The code follows a Laravel-style layout: Controllers → Requests → Services → Repositories → Models, with Resources shaping the output.

## API documentation

| | |
|---|---|
| **Swagger UI** (interactive, "Try it out" works) | http://localhost:3000/api/docs |
| OpenAPI 3.1 JSON | http://localhost:3000/api/docs.json |
| Same spec as a file, readable without running the API | [openapi.json](openapi.json) (paste into https://editor.swagger.io) |
| Written reference | [API.md](API.md) |
| Assumptions | [ASSUMPTIONS.md](ASSUMPTIONS.md) |

The OpenAPI document is generated from the code itself:
- request schemas come from the same Zod rules that validate requests
- response schemas come from the resources that build responses
- every example is produced by the real resource and error-rendering code

The test suite checks every real response against those same schemas, so the docs can't drift from the API. After changing an endpoint, run `npm run docs:export` to refresh `openapi.json`; a test fails if you forget.

## Run it

### Get the code

```bash
git clone https://github.com/pellakurusumanth4-oss/Assignments.git
cd Assignments/transaction-ledger-api
```

### Option A: Docker (API + database, nothing else to install)

```bash
docker compose up --build
```

The API is on http://localhost:3000/api and the docs on http://localhost:3000/api/docs. Migrations run automatically on startup.
If port 3000 or 5432 is already taken, pick others: `API_PORT=3001 DB_PORT=5433 docker compose up --build`.

### Option B: Node locally

Requires Node.js 22.18+ (it runs TypeScript directly, no build step) and PostgreSQL 14+.

```bash
cp .env.example .env          # point DATABASE_URL at your Postgres
docker compose up -d db       # or use any Postgres you already have
npm install
npm start                     # or: npm run dev (restarts on file changes)
```

### Quick try

```bash
curl -X POST localhost:3000/api/accounts -H 'content-type: application/json' -d '{"name":"Asha"}'
# copy data.id from the response
curl -X POST localhost:3000/api/accounts/<id>/transactions -H 'content-type: application/json' \
  -d '{"type":"credit","amount":100,"description":"Salary","reference_id":"inv-001"}'
curl localhost:3000/api/accounts/<id>/balance
curl 'localhost:3000/api/accounts/<id>/transactions?type=credit&page=1&limit=10'
```

Every response uses the same envelope: `{ "success": true, "data": …, "message": "…" }` on success, `{ "success": false, "message": "…" }` on error.

## Tests

45 integration tests, run against a real PostgreSQL:

| Suite | What it proves |
|---|---|
| `test/apis/*` | every rule in the brief through real HTTP, including 10 concurrent debits (exactly 3 succeed), 8 concurrent retries of one `reference_id` (exactly 1 applied) and 20 opposite-direction transfers at once (no deadlock, money conserved). Every response is parsed with the documented schemas. |
| `test/apis/DocsApi` | Swagger UI and the OpenAPI JSON are served, list every endpoint, and `openapi.json` is up to date |
| `test/integration/LedgerIntegrity` | every account's balance equals the sum of its transactions |
| `test/integration/Atomicity` | when the insert fails after the balance moved, the balance change is rolled back too |
| `test/integration/DatabaseResilience` | the API survives Postgres dropping a connection, both idle and mid-transaction (with a full rollback) |
| `test/integration/Server` | `SIGTERM` shuts down gracefully, and a busy port fails loudly instead of pretending to listen |

```bash
docker compose up -d db
npm test                      # uses DATABASE_URL from .env
npm run typecheck
```

The tests only add rows (random new accounts), so they can run against the dev database.

## Requirements checklist

| Brief | Where | Proven by |
|---|---|---|
| 1. Create account (unique id, name required, balance starts at 0, system `created_at`, balance not settable) | `POST /api/accounts`, `Account.rules`, `accounts` table defaults | `AccountApi` tests |
| 2. Add transaction (credit, debit, insufficient balance rejected, duplicate `reference_id` per account) | `POST /api/accounts/{id}/transactions`, `TransactionService.create` | `TransactionApi` tests |
| 3. Get balance (`account_id`, `balance`, error if unknown) | `GET /api/accounts/{id}/balance` | `AccountApi` tests |
| 4. History (type filter, `page`/`limit`, page metadata, latest first) | `GET /api/accounts/{id}/transactions` | `TransactionApi history` tests |
| 5. Data integrity (immutability, balance consistency, rejected transactions change nothing) | no edit/delete routes, immutability trigger, `CHECK` constraints | `test_transactions_are_immutable`, `LedgerIntegrity` |
| Atomicity (both changes or neither) | `DB.transaction()` in `TransactionService` | `Atomicity` |
| 7. Validations (all 9) | request classes, `exceptions/ValidationException.ts` | validation tests |
| 8. Error handling (7 listed cases, consistent responses) | `exceptions/Handler.ts`, one envelope | every error test parses the documented error schema |
| 9. Bonus: transfer (sufficient balance, both accounts exist, atomic, rolled back, never partial) | `POST /api/transfers`, `TransactionService.transfer` | `TransferApi` tests |
| 10. Technical requirements (constraints, structure, validation, runnable from README) | this repository | `docker compose up --build` |
| 11. Submission | source, this README, [API.md](API.md) + Swagger, [ASSUMPTIONS.md](ASSUMPTIONS.md) | |

## Project structure

```
database/migrations/                       SQL migrations, run in name order on startup (idempotent)
src/
  server.ts                                entry point: migrate, listen, graceful shutdown
  app.ts                                   Express app: JSON parser, /api docs + routes, 404, exception handler
  container.ts                             composition root: builds repositories, services, controllers once
  routes/api.ts, routes/docs.ts            route tables (API, Swagger UI)
  controllers/
    AppBaseController.ts                   sendResponse / sendPaginatedResponse
    api/AccountAPIController.ts            POST /accounts, GET /accounts/:id/balance
    api/TransactionAPIController.ts        GET + POST /accounts/:id/transactions
    api/TransferAPIController.ts           POST /transfers
  requests/
    APIRequest.ts                          validated(): runs rules(), throws ValidationException
    api/*APIRequest.ts                     one request class per endpoint
  models/Account.ts, Transaction.ts        row types, table, fillable columns, validation rules
  repositories/
    BaseRepository.ts                      find(), findOrFail(), create() (fillable columns only)
    AccountRepository.ts                   row locking, balance updates
    TransactionRepository.ts               duplicate lookup, paginated history
  services/TransactionService.ts           all money movement (credit, debit, transfer)
  resources/*Resource.ts                   output schema + toArray() for each response shape
  exceptions/                              domain + HTTP exceptions; Handler.ts maps them to status codes
  docs/openapi.ts                          OpenAPI document generated from requests, resources, exceptions
  database/DB.ts                           pool, DB.transaction(), DB.migrate()
  utils/                                   response envelope, validation message helpers
scripts/export-openapi.ts                  writes openapi.json
test/                                      TestCase.ts + ApiTestTrait.ts helpers, apis/, integration/
```

**Request flow:** route → controller → `*APIRequest.validated()` → service (business rules inside `DB.transaction`) → repositories (SQL) → resource (`toArray`) → `sendResponse`. Anything thrown on the way is rendered by `exceptions/Handler.ts`.

## Design principles

| Principle | Where it shows |
|---|---|
| **Single responsibility** | Each layer has one job. Requests validate, services hold business rules, repositories run SQL, resources shape JSON, `Handler` maps errors to HTTP. Controllers only orchestrate. |
| **Open/closed** | A new endpoint adds a request class, a controller method and a route without changing existing ones. A new error type adds one exception class and one line in `Handler`. |
| **Liskov substitution** | `AccountRepository` and `TransactionRepository` extend `BaseRepository` without changing what `find`/`findOrFail`/`create` do. Resources share `JsonResource.collection()`. |
| **Interface segregation** | Each controller receives only what it uses. `TransferAPIController` gets just the service; `AccountAPIController` gets just the account repository. |
| **Dependency inversion** | Dependencies are passed through constructors and imported as *types* only. `container.ts` is the single place that chooses concrete classes, so any piece can be swapped (e.g. a fake repository in a test). |
| **Layer isolation** | Services throw domain exceptions (`InsufficientBalanceException`, `DuplicateTransactionException`, `ModelNotFoundException`) with no HTTP knowledge. Only `Handler` knows status codes. |
| **Single source of truth** | Zod schemas drive validation, response typing (`toArray` must return its schema's type), the Swagger docs and the test assertions. |

## Design decisions

**Balance is a stored column, updated in the same DB transaction as the insert.** Reads stay O(1), and `DB.transaction()` guarantees atomicity: if the insert fails, the balance update is rolled back with it.

**`DB.transaction()` works like Laravel's.** It keeps the open connection in `AsyncLocalStorage`, so every repository call inside the callback joins the transaction automatically, with no database client passed around.

**Concurrency: lock the account row first.** `TransactionService` starts every write with `SELECT … FOR UPDATE`. Writes to the same account run one after the other, so the balance check can't be fooled by a race. The test suite fails if the lock is removed.

**Duplicates (idempotency):** `reference_id` is checked under that same lock, and `UNIQUE (account_id, reference_id)` in the database is a second line of defence. A duplicate returns `409` with the original transaction's id, and the balance doesn't change. Duplicates are checked before the balance, so retrying a request that already succeeded reports "already exists", never "insufficient balance".

**Data integrity in the database, not only the code:**
- `CHECK (balance >= 0)`, `CHECK (amount > 0)`, `CHECK (type IN ('credit','debit'))`, `NOT NULL` and a foreign key.
- `numeric(18,2)` for money in storage and arithmetic.
- A trigger rejects any `UPDATE` or `DELETE` on `transactions`, so ledger entries are immutable even through direct SQL. The API also has no edit or delete routes.

**Ordering:** `created_at` uses `clock_timestamp()`, not `now()`. `now()` is frozen at the start of the DB transaction, so a request that waited for the lock would get an earlier timestamp than the request it waited behind. Ties are broken by `id`, so pagination is stable.

**Transfers (bonus):** both account rows are locked in a fixed order (by id), so two transfers in opposite directions can't deadlock. The debit and credit are two normal ledger entries sharing the transfer's `reference_id`, written in one DB transaction, so a partial transfer is impossible. Account ids are lower-cased on input because Postgres returns them lower-case.

**Resilience:**
- A dropped database connection (Postgres restart or failover) is logged and replaced instead of crashing the process. A connection lost mid-transaction is rolled back and discarded, never returned to the pool.
- `SIGTERM` (`docker stop`) stops accepting connections, lets in-flight requests finish, then closes the pool.
- A busy port exits with `EADDRINUSE` instead of logging "listening".

**Validation:** each endpoint has a request class whose `rules()` are Zod schemas, mostly defined on the model. A failure returns `422` with Laravel-style messages: `message` holds the first error, and `errors` lists every message by field. Unknown fields such as `balance` are rejected as "prohibited", so clients can't set the initial balance.
