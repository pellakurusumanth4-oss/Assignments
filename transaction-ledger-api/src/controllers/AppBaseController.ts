import type { Response } from 'express';
import type { z } from 'zod';
import type { PaginationResource } from '../resources/PaginationResource.ts';
import { ResponseUtil } from '../utils/ResponseUtil.ts';

/**
 * Parent class for API controllers: one place that shapes every successful JSON response.
 * Errors are thrown and rendered by exceptions/Handler.ts.
 */
export class AppBaseController {
  sendResponse(res: Response, result: unknown, message: string, code = 200): void {
    res.status(code).json(ResponseUtil.makeResponse(message, result));
  }

  sendPaginatedResponse(
    res: Response,
    result: unknown[],
    pagination: z.output<typeof PaginationResource.schema>,
    message: string,
  ): void {
    res.json({ ...ResponseUtil.makeResponse(message, result), pagination });
  }
}
