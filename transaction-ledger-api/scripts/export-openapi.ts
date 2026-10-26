// Writes openapi.json so the docs can be read without running the API (e.g. in editor.swagger.io).
import { writeFile } from 'node:fs/promises';
import { openApiDocument } from '../src/docs/openapi.ts';

await writeFile(new URL('../openapi.json', import.meta.url), `${JSON.stringify(openApiDocument, null, 2)}\n`);
console.log('Wrote openapi.json');
