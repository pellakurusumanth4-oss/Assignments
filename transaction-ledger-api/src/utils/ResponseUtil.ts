import { z } from 'zod';

/** The API's JSON envelope (InfyOm-style). The schemas describe it in the Swagger docs and are checked in tests. */
export const ResponseUtil = {
  makeResponse: (message: string, data: unknown) => ({ success: true, data, message }),

  makeError: (message: string, data?: Record<string, unknown>) => ({
    success: false,
    message,
    ...(data !== undefined && { data }),
  }),

  responseSchema: (data: z.ZodType, extra: z.ZodRawShape = {}) =>
    z.strictObject({ success: z.literal(true), data, message: z.string(), ...extra }),

  errorSchema: z.strictObject({
    success: z.literal(false),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),

  validationErrorSchema: z.strictObject({
    success: z.literal(false),
    message: z.string(),
    errors: z.record(z.string(), z.array(z.string())),
  }),
};
