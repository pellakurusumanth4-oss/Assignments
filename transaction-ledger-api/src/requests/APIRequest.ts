import type { z } from 'zod';
import { ValidationException } from '../exceptions/ValidationException.ts';

/** Parent class for API requests: subclasses define `rules()`, controllers call `validated()`. */
export abstract class APIRequest {
  /** Returns the parsed input, or throws a 422 ValidationException listing every invalid field. */
  static validated<S extends z.ZodType>(this: { rules(): S }, data: unknown): z.output<S> {
    const result = this.rules().safeParse(data);
    if (!result.success) throw ValidationException.fromZodError(result.error);
    return result.data;
  }
}
