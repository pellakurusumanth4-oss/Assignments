import type { z } from 'zod';

/** Invalid request input; rendered as 422 with Laravel's shape: first message as `message`, all under `errors`. */
export class ValidationException extends Error {
  errors: Record<string, string[]>;

  constructor(errors: Record<string, string[]>) {
    const messages = Object.values(errors).flat();
    const more = messages.length - 1;
    super(more > 0 ? `${messages[0]} (and ${more} more error${more > 1 ? 's' : ''})` : messages[0]);
    this.errors = errors;
  }

  static fromZodError(error: z.ZodError): ValidationException {
    const errors: Record<string, string[]> = {};
    const add = (field: string, message: string) => (errors[field] ??= []).push(message);

    for (const issue of error.issues) {
      if (issue.code === 'unrecognized_keys') {
        issue.keys.forEach((key) => add(key, `The ${key.replaceAll('_', ' ')} field is prohibited.`));
      } else if (issue.path.length === 0) {
        add('body', 'The request body must be a JSON object.');
      } else {
        add(issue.path.join('.'), issue.message);
      }
    }
    return new ValidationException(errors);
  }
}
