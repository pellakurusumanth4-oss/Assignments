/** A debit would take the balance below zero. Rendered as 422. */
export class InsufficientBalanceException extends Error {
  balance: number;
  amount: number;

  constructor(balance: number, amount: number) {
    super('Insufficient balance');
    this.balance = balance;
    this.amount = amount;
  }
}
