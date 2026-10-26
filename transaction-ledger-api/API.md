# API Reference

> Interactive version: **Swagger UI at http://localhost:3000/api/docs** (OpenAPI 3.1 JSON at `/api/docs.json`, or the [openapi.json](openapi.json) file).

Base URL: `http://localhost:3000/api`. All bodies are JSON (`Content-Type: application/json`).
Amounts are JSON numbers with at most 2 decimal places. Timestamps are UTC, formatted `YYYY-MM-DD HH:MM:SS`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/accounts` | Create an account |
| GET | `/accounts/{id}/balance` | Current balance |
| POST | `/accounts/{id}/transactions` | Add a credit or debit |
| GET | `/accounts/{id}/transactions` | Transaction history (filter, paginate) |
| POST | `/transfers` | Move money between two accounts (bonus) |

## Response envelope

Success:

```json
{ "success": true, "data": { … }, "message": "Account saved successfully" }
```

Error:

```json
{ "success": false, "message": "Account not found" }
```

Some errors add a `data` object with details (see each endpoint). Validation errors (`422`) add `errors`, listing every message by field:

```json
{
  "success": false,
  "message": "The selected type is invalid. (and 2 more errors)",
  "errors": {
    "type": ["The selected type is invalid."],
    "amount": ["The amount field must be greater than 0."],
    "reference_id": ["The reference id field is required."]
  }
}
```

Errors common to every endpoint:

| Status | Message |
|---|---|
| 400 | `Malformed JSON request body` |
| 404 | `Account not found`: unknown or malformed account id in the URL (ids are case-insensitive) |
| 404 | `Route not found`: unknown route, including any attempt to `PUT`/`DELETE` a transaction |
| 413 | `Request entity too large`: body over 100 kB |
| 415 | `Unsupported charset "…"`: send UTF-8 |
| 422 | validation failure, shaped as above |
| 500 | `Server Error` |

---

## POST /accounts

Request:

```json
{ "name": "Asha" }
```

| Field | Rules |
|---|---|
| `name` | required string, 1–100 characters after trimming |

Any other field is prohibited (`422`), so the client can't set `balance`, `id` or `created_at`.

Response `201`:

```json
{
  "success": true,
  "data": {
    "id": "f029211e-f5fe-4a0e-811e-5a4a5cd32157",
    "name": "Asha",
    "balance": 0,
    "created_at": "2026-10-26 14:03:35"
  },
  "message": "Account saved successfully"
}
```

---

## GET /accounts/{id}/balance

Response `200`:

```json
{
  "success": true,
  "data": { "account_id": "f029211e-f5fe-4a0e-811e-5a4a5cd32157", "balance": 100 },
  "message": "Account balance retrieved successfully"
}
```

---

## POST /accounts/{id}/transactions

Request:

```json
{ "type": "debit", "amount": 30, "description": "Groceries", "reference_id": "order-1042" }
```

| Field | Rules |
|---|---|
| `type` | required, `credit` or `debit` |
| `amount` | required number, > 0, 0–2 decimal places, at most 1000000000 |
| `reference_id` | required string, 1–100 characters; unique per account |
| `description` | optional string, up to 255 characters (defaults to `""`) |

Response `201`:

```json
{
  "success": true,
  "data": {
    "id": "ec711fe8-af62-440d-8794-9d4ffd64d7b1",
    "account_id": "f029211e-f5fe-4a0e-811e-5a4a5cd32157",
    "type": "debit",
    "amount": 30,
    "description": "Groceries",
    "reference_id": "order-1042",
    "created_at": "2026-10-26 14:03:35"
  },
  "message": "Transaction saved successfully"
}
```

Errors:

| Status | Message | `data` |
|---|---|---|
| 404 | `Account not found` | |
| 409 | `A transaction with this reference_id already exists` | `{ "transaction_id": "<the original>" }` |
| 422 | `Insufficient balance` | `{ "balance": 100, "amount": 150 }` |
| 422 | validation errors | |

---

## GET /accounts/{id}/transactions

| Query param | Default | Rules |
|---|---|---|
| `type` | both | `credit` or `debit` |
| `page` | `1` | integer ≥ 1 |
| `limit` | `20` | integer 1–100 |

Sorted latest first by `created_at` (ties broken by `id`).

Response `200`:

```json
{
  "success": true,
  "data": [
    {
      "id": "ec711fe8-af62-440d-8794-9d4ffd64d7b1",
      "account_id": "f029211e-f5fe-4a0e-811e-5a4a5cd32157",
      "type": "credit",
      "amount": 100,
      "description": "Salary",
      "reference_id": "inv-001",
      "created_at": "2026-10-26 14:03:35"
    }
  ],
  "message": "Transactions retrieved successfully",
  "pagination": { "page": 1, "limit": 20, "total_records": 1, "total_pages": 1 }
}
```

A page past the end returns `data: []` with the same pagination totals.

---

## POST /transfers (bonus)

Request:

```json
{
  "from_account_id": "…uuid…",
  "to_account_id": "…uuid…",
  "amount": 30,
  "description": "Rent share",
  "reference_id": "transfer-77"
}
```

`from_account_id` and `to_account_id` are required, must be valid UUIDs (any letter case) and must be different. `amount`, `description` and `reference_id` follow the transaction rules.

Response `201`: both ledger entries, created in one atomic operation.

```json
{
  "success": true,
  "data": {
    "debit":  { "id": "…", "account_id": "<from>", "type": "debit",  "amount": 30, "reference_id": "transfer-77", "…": "…" },
    "credit": { "id": "…", "account_id": "<to>",   "type": "credit", "amount": 30, "reference_id": "transfer-77", "…": "…" }
  },
  "message": "Transfer completed successfully"
}
```

Errors: `404 Source account not found` / `404 Destination account not found`, `409` when the `reference_id` is already used on either account (`data.transaction_id` points to the existing entry, preferring the source account's), `422 Insufficient balance` with `data`, and `422` validation errors. On any error, neither balance changes.
