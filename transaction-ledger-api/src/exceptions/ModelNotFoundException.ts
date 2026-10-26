/** A looked-up record doesn't exist (like Eloquent's ModelNotFoundException); rendered as 404. */
export class ModelNotFoundException extends Error {
  constructor(model: string) {
    super(`${model} not found`);
  }
}
