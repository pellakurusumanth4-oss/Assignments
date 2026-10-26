import { z } from 'zod';
import { JsonResource } from './JsonResource.ts';

export class PaginationResource extends JsonResource {
  static schema = z.strictObject({
    page: z.int().min(1),
    limit: z.int().min(1),
    total_records: z.int().min(0),
    total_pages: z.int().min(0),
  });

  static toArray({ page, limit, total }: { page: number; limit: number; total: number }): z.output<typeof PaginationResource.schema> {
    return { page, limit, total_records: total, total_pages: Math.ceil(total / limit) };
  }
}
