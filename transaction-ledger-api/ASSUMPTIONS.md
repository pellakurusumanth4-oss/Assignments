# Assumptions

1. **Single currency, 2 decimal places.** Amounts are JSON numbers with at most 2 decimals, stored as `numeric(18,2)`. More decimals are rejected rather than rounded, so money is never silently changed.
2. **Per-transaction cap of 1000000000.** Amounts and balances are returned as JSON numbers, which are exact to the cent up to about 90 trillion (2^53 / 100). A system expecting larger balances would return money as strings or integer cents instead.
3. **IDs are server-generated UUIDs, compared case-insensitively.** An account id in the URL that is unknown *or* not a valid UUID returns `404 Account not found`. In a request body (transfers), a malformed id is a `422` validation error. Responses always use lower-case ids.
4. **Duplicate = same `reference_id` on the same account, whatever the other fields are.** The duplicate gets `409 A transaction with this reference_id already exists`, and `data.transaction_id` points to the original, so a client retrying after a timeout can look up what was recorded.
5. **Rejected transactions are not stored.** A debit refused for insufficient balance leaves no record and doesn't use up its `reference_id`, so the same request can succeed later once the account has funds.
6. **`description` is optional** (defaults to an empty string). The brief lists it as a field but not among the required validations.
7. **Unknown fields are rejected** (`422`, "The x field is prohibited.") on every request body. This is how "the client cannot set the initial balance" is enforced, and it also stops clients from sending their own `id` or `created_at`.
8. **Status codes:** `201` for anything created, `422` for invalid input *and* for insufficient balance (a well-formed request that breaks a business rule), `409` for duplicates, `404` for unknown accounts or routes.
9. **Response envelope:** every response is `{ success, data, message }` (errors: `{ success: false, message }`, plus `errors` or `data` when there are details). This keeps clients' response handling uniform.
10. **Timestamps** are returned in UTC as `YYYY-MM-DD HH:MM:SS`. Ordering uses the full-precision value stored in the database.
11. **Pagination is page-based** (`page`/`limit`, max `limit` 100). A page past the end returns an empty list, not an error.
12. **Transfers are two ordinary ledger entries** (a debit on the source, a credit on the destination) sharing the transfer's `reference_id`. No separate transfers table is needed, and both entries appear in each account's history. The `reference_id` must be unused on both accounts.
13. **Accounts can't be renamed or deleted.** The brief doesn't ask for it, and deleting an account with history would break the ledger.
14. **No authentication.** It's out of scope for the brief; in production every route would sit behind auth with per-account authorisation.
