import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiDocument } from '../docs/openapi.ts';

export const docs = Router();

docs.get('/docs.json', (_req, res) => {
  res.json(openApiDocument);
});

docs.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument, {
    customSiteTitle: 'Transaction Ledger API docs',
    swaggerOptions: { tryItOutEnabled: true, displayRequestDuration: true },
  }),
);
