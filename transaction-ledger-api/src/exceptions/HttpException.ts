/** An error that maps directly to an HTTP status and a `{ success: false, message, data? }` body. */
export class HttpException extends Error {
  status: number;
  data?: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}
