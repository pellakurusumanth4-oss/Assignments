import { z } from 'zod';

/**
 * Parent class for resources. Each subclass declares `schema` (its JSON output, used by the Swagger
 * docs and checked in tests) and `toArray()` (typed to return exactly that shape).
 */
export abstract class JsonResource {
  static collection<T, R>(this: { toArray(item: T): R }, items: T[]): R[] {
    return items.map((item) => this.toArray(item));
  }
}

/** Formats as `Y-m-d H:i:s` in UTC. */
export const formatDateTime = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');

export const dateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  .describe('UTC, YYYY-MM-DD HH:MM:SS');
