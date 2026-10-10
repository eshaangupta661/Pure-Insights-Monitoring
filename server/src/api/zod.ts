import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * zod with `.openapi()` metadata (zod-to-openapi). Every API schema imports `z` from here so the
 * extension is applied before any schema is built.
 */
extendZodWithOpenApi(z);

export { z };
