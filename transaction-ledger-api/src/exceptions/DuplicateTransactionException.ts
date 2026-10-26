/** The reference_id was already used; carries the original's id so a retrying client can look it up. Rendered as 409. */
export class DuplicateTransactionException extends Error {
  transactionId: string;

  constructor(transactionId: string) {
    super('A transaction with this reference_id already exists');
    this.transactionId = transactionId;
  }
}
