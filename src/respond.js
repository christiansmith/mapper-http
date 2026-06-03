/**
 * Dependencies
 */
import { corsHeaders } from './cors.js'

/**
 * json
 *
 * JSON response with optional CORS headers.
 *
 * @param {unknown} data
 * @param {number} [status]
 * @param {object|null} [cors]
 * @param {Request} [req]
 * @returns {Response}
 */
function json(data, status, cors, req) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(req, cors)
    }
  })
}

/**
 * error
 *
 * Structured error response of the shape `{ error, detail }`.
 *
 * @param {string} code - short machine-readable error code
 * @param {string} detail - human-readable detail
 * @param {number} [status]
 * @param {object|null} [cors]
 * @param {Request} [req]
 * @returns {Response}
 */
function error(code, detail, status, cors, req) {
  return json({ error: code, detail }, status || 500, cors, req)
}

export { error, json }
