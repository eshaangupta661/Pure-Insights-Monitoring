/** `npm run openapi`: regenerates docs/openapi.yaml from the route declarations. */
import fs from 'node:fs';
import { OPENAPI_PATH } from '../paths.js';
import { buildOpenApiDocument, openApiYaml } from './openapi.js';

const doc = buildOpenApiDocument();
fs.writeFileSync(OPENAPI_PATH, openApiYaml(doc));
console.log(`Wrote ${OPENAPI_PATH} (${Object.keys(doc.paths ?? {}).length} paths)`);
