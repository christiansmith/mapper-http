/**
 * Response helpers: a consistent JSON envelope, request-id generation, and the
 * common headers (Content-Type, Cache-Control, X-Request-Id, CORS) on every
 * response.
 *
 * Two response shapes:
 *   - `json(data, …)` — a success body, returned verbatim. For `POST /map`
 *     this is the mapper result (`{ output, valid, errors }`); its `valid` and
 *     `errors` are *data* for the caller to inspect, not a transport error.
 *   - `error(err, …)` — a server error: `{ code, message, requestId }`
 *     (plus `errors` for validation errors, or `report` for invalid mapping
 *     documents). 5xx detail is suppressed under `errorDetail: "minimal"`.
 */
import { ApiError } from './errors.js'

/**
 * Generate a request id: prefix + 12 random hex chars.
 * @param {string} [prefix]
 */
export function requestId(prefix = 'req_') {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * @param {string} reqId
 * @param {Record<string, string>} cors already-computed CORS headers
 */
function baseHeaders(reqId, cors) {
  return {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-request-id': reqId,
    ...cors
  }
}

/**
 * JSON success response.
 * @param {unknown} data
 * @param {{ status?: number, reqId: string, cors?: Record<string, string> }} opts
 */
export function json(data, { status = 200, reqId, cors = {} }) {
  return new Response(JSON.stringify(data), { status, headers: baseHeaders(reqId, cors) })
}

/**
 * Structured error response. Known ApiErrors map to their code/status; any
 * other error becomes a 500 InternalError. In `minimal` mode (default), 5xx
 * detail is replaced with a generic message and never leaks internals; 4xx
 * messages are always returned (they tell the client what to fix). Full detail
 * is expected to be logged server-side regardless.
 * @param {unknown} err
 * @param {{ reqId: string, cors?: Record<string, string>, errorDetail?: 'minimal' | 'full' }} opts
 */
export function error(err, { reqId, cors = {}, errorDetail = 'minimal' }) {
  const isApi = err instanceof ApiError
  const status = isApi ? err.status : 500
  const code = isApi ? err.code : 'InternalError'
  let message = err instanceof Error ? err.message : 'An unexpected error occurred'

  if (status >= 500 && errorDetail !== 'full') {
    message = 'An unexpected error occurred'
  }

  /** @type {Record<string, unknown>} */
  const body = { code, message }
  if (isApi && /** @type {any} */ (err).errors) {
    body.errors = /** @type {any} */ (err).errors
  }
  if (isApi && /** @type {any} */ (err).report) {
    body.report = /** @type {any} */ (err).report
  }
  if (isApi && /** @type {any} */ (err).location) {
    body.location = /** @type {any} */ (err).location
  }
  body.requestId = reqId

  return new Response(JSON.stringify(body), { status, headers: baseHeaders(reqId, cors) })
}
