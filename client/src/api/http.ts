import type { ApiError } from '@pic/shared';

/** A non-2xx API response, carrying the server's `{ error: { code, message } }`. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const BASE = '/api/v1';

/** Same-origin request; the session is the httpOnly `pic_token` cookie. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiRequestError(0, 'NETWORK', 'Cannot reach the server');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = (json as ApiError | undefined)?.error;
    throw new ApiRequestError(
      res.status,
      err?.code ?? 'ERROR',
      err?.message ?? `HTTP ${res.status}`,
    );
  }
  return json as T;
}
