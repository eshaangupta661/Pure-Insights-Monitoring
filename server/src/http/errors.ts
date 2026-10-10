import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@pic/shared';

/** Error codes the API returns in `{ error: { code } }`. Documented in docs/API.md. */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'BAD_ORIGIN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export function apiError(code: ErrorCode, message: string): ApiError {
  return { error: { code, message } };
}

/** Throw from a handler or middleware; the error middleware turns it into the JSON shape. */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} not found`);

/** "query.page: Number must be greater than or equal to 1" */
function describeZodError(err: ZodError, where: string): string {
  const issue = err.issues[0];
  if (!issue) return `Invalid ${where}`;
  const path = [where, ...issue.path].join('.');
  return `${path}: ${issue.message}`;
}

/** A ZodError from parsing request input, tagged with where the input came from. */
export class RequestValidationError extends Error {
  override name = 'RequestValidationError';
  constructor(
    readonly where: 'query' | 'params' | 'body',
    readonly zodError: ZodError,
  ) {
    super(describeZodError(zodError, where));
  }
}

/**
 * Last middleware. Express 5 forwards rejected async handlers here, so no express-async-errors.
 * A bare ZodError (not a RequestValidationError) means our own response failed its schema: a
 * server bug, so 500.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json(apiError(err.code, err.message));
    return;
  }
  if (err instanceof RequestValidationError) {
    res.status(400).json(apiError('VALIDATION_ERROR', err.message));
    return;
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // e.g. malformed JSON body from express.json()
    res.status(status).json(apiError('BAD_REQUEST', 'Bad request'));
    return;
  }
  console.error(err);
  res.status(500).json(apiError('INTERNAL', 'Internal server error'));
};
