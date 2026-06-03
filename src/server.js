/**
 * Dependencies
 */
import Mapper from '@christiansmith/mapper-js'
import createVerifier from './auth.js'
import { preflight } from './cors.js'
import { error, json } from './respond.js'

/**
 * createServer
 *
 * Expose a Mapper instance over HTTP. A deployment supplies its own mappings
 * and extensions; this server adds authentication, CORS, and a small set of
 * endpoints for running mappings.
 *
 * @param {object} [mappings] - Mapper descriptor, e.g. { $id, mappings }
 * @param {object} [extensions] - { initializers, transformers, plugins }
 * @param {object} [options]
 * @param {object} [options.auth] - { jwksUri, issuer, audience }; omit to disable auth
 * @param {object} [options.cors] - { origin, methods, headers }; omit to disable CORS
 * @returns {{ fetch: (req: Request) => Promise<Response>, listen: (opts?: object) => unknown, mapper: Mapper }}
 */
function createServer(mappings, extensions, options) {
  const opts = options || {}
  const mapper = new Mapper(mappings || { mappings: {} }, extensions || {})
  const verify = opts.auth ? createVerifier(opts.auth) : null
  const cors = opts.cors || null

  /**
   * handle - route a request to a response
   */
  async function handle(req) {
    const url = new URL(req.url)
    const method = req.method
    const path = url.pathname

    // CORS preflight
    if (method === 'OPTIONS') {
      return preflight(req, cors)
    }

    // health check (unauthenticated)
    if (path === '/health') {
      if (method !== 'GET') {
        return error('method_not_allowed', 'Use GET', 405, cors, req)
      }

      return json({ status: 'ok' }, 200, cors, req)
    }

    // authenticate everything else when auth is configured
    let identity = null

    if (verify) {
      const header = req.headers.get('authorization') || ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : null

      if (!token) {
        return error('unauthorized', 'Missing bearer token', 401, cors, req)
      }

      try {
        identity = await verify(token)
      } catch (err) {
        return error('invalid_token', err.message, 401, cors, req)
      }
    }

    // run a named mapping over a supplied input
    if (path === '/map') {
      if (method !== 'POST') {
        return error('method_not_allowed', 'Use POST', 405, cors, req)
      }

      return runMapping(req, mapper, identity, cors)
    }

    // list registered mappings
    if (path === '/mappings') {
      if (method !== 'GET') {
        return error('method_not_allowed', 'Use GET', 405, cors, req)
      }

      return json(mapper.mappings, 200, cors, req)
    }

    return error('not_found', `No route for ${method} ${path}`, 404, cors, req)
  }

  /**
   * fetch - handler with a last-resort error boundary
   */
  async function fetch(req) {
    try {
      return await handle(req)
    } catch (err) {
      return error('internal_error', err.message, 500, cors, req)
    }
  }

  /**
   * listen - start a Deno.serve listener
   */
  function listen(serveOptions) {
    return Deno.serve(serveOptions || {}, fetch)
  }

  return { fetch, listen, mapper }
}

/**
 * runMapping
 *
 * Handle `POST /map` with a body of `{ mapping, input }`. `input` is passed to
 * the mapper as-is (the generic escape hatch); the authenticated identity is
 * provided to the mapper as `context.identity`.
 *
 * @param {Request} req
 * @param {Mapper} mapper
 * @param {object|null} identity
 * @param {object|null} cors
 * @returns {Promise<Response>}
 */
async function runMapping(req, mapper, identity, cors) {
  let payload

  try {
    payload = await req.json()
  } catch {
    return error('bad_request', 'Body must be valid JSON', 400, cors, req)
  }

  const mapping = payload && payload.mapping
  const input = payload && payload.input

  if (!mapping) {
    return error('bad_request', 'Missing "mapping"', 400, cors, req)
  }

  const result = await mapper.map(mapping, input, { identity })

  if (result && result.valid === false) {
    return json({ error: 'unprocessable', errors: result.errors }, 422, cors, req)
  }

  return json(result, 200, cors, req)
}

export default createServer
