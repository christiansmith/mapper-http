/**
 * Dependencies
 */
import Mapper from '@christiansmith/mapper-js'
import { checkClaims, createAuthenticator } from './auth.js'
import { corsHeaders } from './cors.js'
import { error, json, requestId } from './respond.js'
import { createLogger } from './log.js'
import {
  BadRequestError,
  ForbiddenError,
  InvalidMappingDocumentError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError
} from './errors.js'

/** Default request-body cap (1 MiB). */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/**
 * createServer
 *
 * Expose a Mapper instance over HTTP. A deployment supplies its own mappings
 * and extensions; this server adds authentication, CORS, structured logging,
 * and a small set of endpoints for running mappings.
 *
 * Error handling has two planes:
 *   - **Server errors** (bad JSON, missing fields, oversized body, auth,
 *     routing, unexpected exceptions) render as `{ code, message, requestId }`;
 *     5xx detail is suppressed unless `errorDetail: "full"`.
 *   - **Mapping results** are returned as data at 200, including `valid` and
 *     `errors` for the caller to inspect. A deployment may opt to promote a
 *     `valid:false` result into a client error via `map.invalidStatus`.
 *
 * @param {object} [mappings] - Mapper descriptor, e.g. { $id, mappings }
 * @param {object} [extensions] - { initializers, transformers, plugins }
 * @param {object} [options]
 * @param {object} [options.auth] - { secret | publicKey | jwksUri, algorithm, issuer, audience, clockSkew }; omit to disable auth
 * @param {object} [options.cors] - { origin, methods, headers }; omit to disable CORS
 * @param {object} [options.logging] - { format: 'json'|'pretty', level, slowThreshold }
 * @param {'minimal'|'full'} [options.errorDetail] - 5xx detail policy (default 'minimal')
 * @param {number} [options.maxBodyBytes] - reject larger request bodies with 413 (default 1 MiB)
 * @param {string} [options.requestIdPrefix] - prefix for generated request ids (default 'req_')
 * @param {object} [options.map] - { invalidStatus?: number, claims?: Record<string, unknown>, explicit?: boolean | { claims?: Record<string, unknown> } }
 * @returns {{ fetch: (req: Request) => Promise<Response>, listen: (opts?: object) => unknown, mapper: Mapper }}
 */
function createServer(mappings, extensions, options) {
  const opts = options || {}
  const engineExtensions = extensions || {}
  const mapper = new Mapper(mappings || { mappings: {} }, engineExtensions)
  const authenticate = opts.auth ? createAuthenticator(opts.auth) : null
  const corsConfig = opts.cors || null
  const logger = createLogger(opts.logging || {})
  const errorDetail = opts.errorDetail === 'full' ? 'full' : 'minimal'
  const maxBodyBytes = opts.maxBodyBytes || DEFAULT_MAX_BODY_BYTES
  const mapOptions = opts.map || {}
  const invalidStatus = mapOptions.invalidStatus || null
  const mapClaims = mapOptions.claims || null
  const explicitEnabled = Boolean(mapOptions.explicit)
  const explicitClaims =
    (typeof mapOptions.explicit === 'object' && mapOptions.explicit !== null && mapOptions.explicit.claims) || null
  const requestIdPrefix = opts.requestIdPrefix || 'req_'

  /**
   * route - resolve a request to a Response, throwing ApiErrors for the
   * boundary to render.
   * @param {Request} req
   * @param {string} pathname
   * @param {string} reqId
   * @param {Record<string, string>} cors
   */
  async function route(req, pathname, reqId, cors) {
    const method = req.method

    // CORS preflight (unauthenticated).
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'x-request-id': reqId } })
    }

    // Health check (unauthenticated).
    if (pathname === '/health') {
      if (method !== 'GET') {
        throw new MethodNotAllowedError('Use GET')
      }
      return json({ status: 'ok' }, { reqId, cors })
    }

    // Authenticate everything else when auth is configured.
    let identity = null
    if (authenticate) {
      identity = await authenticate(req)
    }

    // Run a registered mapping over a supplied input.
    if (pathname === '/map') {
      if (method !== 'POST') {
        throw new MethodNotAllowedError('Use POST')
      }
      if (mapClaims && !checkClaims(identity, mapClaims)) {
        throw new ForbiddenError('Caller lacks the claims required for /map')
      }
      return runMapping(req, reqId, cors, identity)
    }

    // List registered mappings.
    if (pathname === '/mappings') {
      if (method !== 'GET') {
        throw new MethodNotAllowedError('Use GET')
      }
      return json(mapper.mappings, { reqId, cors })
    }

    throw new NotFoundError(`No route for ${method} ${pathname}`)
  }

  /**
   * isPlainObject - a non-null, non-array object: the shape of a mapping
   * document (single descriptor or compound) as opposed to a registered id.
   * @param {unknown} value
   */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /**
   * resultResponse - render a mapping result. The result is data at 200
   * unless the deployment opts to promote a `valid:false` result into a
   * client error via `map.invalidStatus`; both `/map` forms share this.
   * @param {any} result
   * @param {string} reqId
   * @param {Record<string, string>} cors
   */
  function resultResponse(result, reqId, cors) {
    if (invalidStatus && result && result.valid === false) {
      throw new ValidationError('Mapping validation failed', result.errors, invalidStatus)
    }
    return json(result, { reqId, cors })
  }

  /**
   * runExplicitMapping - evaluate a caller-supplied mapping document.
   *
   * Gate order: the capability must be enabled (`map.explicit`), the caller
   * must satisfy `map.explicit.claims`, and the document must validate —
   * an invalid document gets the full report at 422, never an evaluation
   * attempt. Evaluation is stateless: a fresh engine is built for this call
   * from the registered mappings, the document's own family is registered
   * into it (so references resolve document-first, then installed), and the
   * serving instance is never touched — nothing outlives the request.
   * @param {object} document
   * @param {unknown} input
   * @param {string} reqId
   * @param {Record<string, string>} cors
   * @param {object|null} identity
   */
  async function runExplicitMapping(document, input, reqId, cors, identity) {
    if (!explicitEnabled) {
      throw new ForbiddenError('The explicit mapping form is not enabled on this deployment')
    }
    if (explicitClaims && !checkClaims(identity, explicitClaims)) {
      throw new ForbiddenError('Caller lacks the claims required for explicit mappings')
    }

    const engine = new Mapper({ mappings: mapper.mappings }, engineExtensions)

    if (isPlainObject(document.mappings)) {
      for (const member of Object.values(document.mappings)) {
        engine.add(member)
      }
    }

    const report = engine.validate(document)
    if (!report.valid) {
      throw new InvalidMappingDocumentError(report)
    }

    const result = await engine.map(document, input, { identity })
    return resultResponse(result, reqId, cors)
  }

  /**
   * runMapping - handle `POST /map` with a body of `{ mapping, input }`,
   * discriminated by the type of `mapping`: a string names a registered
   * mapping; an object is an explicit mapping document (when enabled); any
   * other type is a 400. The authenticated identity is provided to the
   * mapper as `context.identity`.
   * @param {Request} req
   * @param {string} reqId
   * @param {Record<string, string>} cors
   * @param {object|null} identity
   */
  async function runMapping(req, reqId, cors, identity) {
    // Reject oversized bodies. Check the declared content-length first (a cheap
    // early reject), then enforce the cap on the actual bytes read — a chunked
    // request, or an in-memory Request, may carry no content-length at all.
    const declaredLength = Number(req.headers.get('content-length') || 0)
    if (declaredLength > maxBodyBytes) {
      throw new PayloadTooLargeError(`Request body exceeds the ${maxBodyBytes}-byte limit`)
    }

    const buffer = await req.arrayBuffer()
    if (buffer.byteLength > maxBodyBytes) {
      throw new PayloadTooLargeError(`Request body exceeds the ${maxBodyBytes}-byte limit`)
    }

    let payload
    try {
      payload = JSON.parse(new TextDecoder().decode(buffer))
    } catch {
      throw new BadRequestError('Body must be valid JSON')
    }

    const mapping = payload && payload.mapping
    const input = payload && payload.input

    if (typeof mapping === 'string') {
      if (!Object.hasOwn(mapper.mappings, mapping)) {
        throw new NotFoundError(`No mapping registered as "${mapping}"`)
      }

      const result = await mapper.map(mapping, input, { identity })
      return resultResponse(result, reqId, cors)
    }

    if (isPlainObject(mapping)) {
      return runExplicitMapping(mapping, input, reqId, cors, identity)
    }

    throw new BadRequestError('"mapping" must be a string naming a registered mapping, or a mapping document object')
  }

  /**
   * fetch - request boundary: assigns a request id, computes CORS, routes,
   * renders any error, and emits one structured log line.
   * @param {Request} req
   */
  async function fetch(req) {
    const start = performance.now()
    const reqId = requestId(requestIdPrefix)
    const cors = corsHeaders(req, corsConfig)
    const { pathname } = new URL(req.url)

    let res
    /** @type {any} */
    let caught = null
    try {
      res = await route(req, pathname, reqId, cors)
    } catch (err) {
      caught = err
      res = error(err, { reqId, cors, errorDetail })
    }

    // One log line per request (warn if slow, error on 5xx). Full error detail
    // is always logged server-side, even when the client response is minimal.
    const duration = Math.round(performance.now() - start)
    /** @type {Record<string, unknown>} */
    const fields = { requestId: reqId, method: req.method, path: pathname, status: res.status, duration }
    if (caught) {
      fields.error = {
        code: caught.code || 'InternalError',
        message: caught instanceof Error ? caught.message : String(caught)
      }
    }
    if (res.status >= 500) {
      logger.error('request failed', fields)
    } else if (duration > logger.slowThreshold) {
      logger.warn('slow request', fields)
    } else {
      logger.info('request completed', fields)
    }
    return res
  }

  /**
   * listen - start a Deno.serve listener
   */
  function listen(serveOptions) {
    return Deno.serve(serveOptions || {}, fetch)
  }

  return { fetch, listen, mapper }
}

export default createServer
