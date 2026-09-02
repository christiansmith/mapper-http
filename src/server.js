/**
 * Dependencies
 */
import Mapper from '@christiansmith/mapper-js'
import { checkClaims, createAuthenticator } from './auth.js'
import { corsHeaders } from './cors.js'
import { error, json, requestId } from './respond.js'
import { createLogger } from './log.js'
import {
  ApiError,
  BadRequestError,
  ForbiddenError,
  InvalidMappingDocumentError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  RedirectRefusedError,
  UnavailableError,
  ValidationError
} from './errors.js'

/** Registry keys that would corrupt a plain-object registry's prototype chain. */
const FORBIDDEN_REGISTRY_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * classifyMapError - promote typed plugin outcomes to client-visible
 * ApiErrors. A refused redirect (mapper-request `E_REDIRECT_REFUSED`) is a
 * policy outcome meeting an ordinary web condition, not an engine fault;
 * detection is by the `code` string — the cross-module contract — never
 * `instanceof`. Everything else rethrows untouched.
 * @param {unknown} err
 * @returns {never}
 */
function classifyMapError(err) {
  if (/** @type {any} */ (err)?.code === 'E_REDIRECT_REFUSED') {
    const { message, location } = /** @type {any} */ (err)
    throw new RedirectRefusedError(message, location)
  }
  throw err
}

/** Maximum nesting depth of a caller-supplied mapping. */
const MAX_MAPPING_DEPTH = 100

/** Default request-body cap (1 MiB). */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/**
 * createServer
 *
 * Expose a Mapper instance over HTTP. A deployment supplies its own mappings
 * and extensions; this server adds authentication, CORS, structured logging,
 * and a small set of endpoints for running, validating, and inspecting
 * mappings.
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
 * @param {object} [options.validate] - { claims?: Record<string, unknown> } gating for POST /validate
 * @param {object} [options.health] - { mapping?: string, timeout?: number } canary configuration for GET /health/mapping
 * @returns {{ fetch: (req: Request) => Promise<Response>, listen: (opts?: object) => unknown, mapper: Mapper }}
 */
function createServer(mappings, extensions, options) {
  const opts = options || {}
  const installedExtensions = extensions || {}
  const mapper = new Mapper(mappings || { mappings: {} }, installedExtensions)
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
  const validateClaims = (opts.validate && opts.validate.claims) || null
  const healthOptions = opts.health || {}
  const healthMapping = healthOptions.mapping || null
  const healthTimeout = healthOptions.timeout || 5000
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

    // Health checks (unauthenticated).
    if (pathname === '/health') {
      if (method !== 'GET') {
        throw new MethodNotAllowedError('Use GET')
      }
      return json({ status: 'ok' }, { reqId, cors })
    }

    if (pathname === '/health/mapping') {
      if (method !== 'GET') {
        throw new MethodNotAllowedError('Use GET')
      }
      return runHealthMapping(reqId, cors)
    }

    // Authenticate everything else when auth is configured.
    let identity = null
    if (authenticate) {
      identity = await authenticate(req)
    }

    // Run a registered or explicit mapping over a supplied input.
    if (pathname === '/map') {
      if (method !== 'POST') {
        throw new MethodNotAllowedError('Use POST')
      }
      if (mapClaims && !checkClaims(identity, mapClaims)) {
        throw new ForbiddenError('Caller lacks the claims required for /map')
      }
      return runMapping(req, reqId, cors, identity)
    }

    // Validate a document or registered mapping against this instance.
    if (pathname === '/validate') {
      if (method !== 'POST') {
        throw new MethodNotAllowedError('Use POST')
      }
      if (validateClaims && !checkClaims(identity, validateClaims)) {
        throw new ForbiddenError('Caller lacks the claims required for /validate')
      }
      return runValidate(req, reqId, cors)
    }

    // List registered mappings.
    if (pathname === '/mappings') {
      if (method !== 'GET') {
        throw new MethodNotAllowedError('Use GET')
      }
      return json(mapper.mappings, { reqId, cors })
    }

    // List installed extension names — the names a mapping author can write
    // against. Names only, never configuration, code, or values.
    if (pathname === '/extensions') {
      if (method !== 'GET') {
        throw new MethodNotAllowedError('Use GET')
      }
      return json(
        {
          initializers: Object.keys(mapper.initializers || {}),
          transformers: Object.keys(mapper.transformers || {}),
          plugins: Object.keys(mapper.plugins || {})
        },
        { reqId, cors }
      )
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
   * readCappedBody - read a request body through the stream, aborting as soon
   * as cumulative bytes exceed `maxBodyBytes` rather than buffering the whole
   * body first. A chunked request, or an in-memory Request, may carry no
   * content-length, so the byte cap is enforced during the read, not after.
   * @param {Request} req
   */
  async function readCappedBody(req) {
    if (!req.body) {
      return new Uint8Array(0)
    }

    const reader = req.body.getReader()
    const chunks = []
    let total = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel()
        throw new PayloadTooLargeError(`Request body exceeds the ${maxBodyBytes}-byte limit`)
      }
      chunks.push(value)
    }

    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return body
  }

  /**
   * readJsonBody - read a request body under the size cap and parse it as
   * JSON. Checks the declared content-length first (a cheap early reject),
   * then enforces the cap on the actual bytes as they stream in.
   * @param {Request} req
   */
  async function readJsonBody(req) {
    const declaredLength = Number(req.headers.get('content-length') || 0)
    if (declaredLength > maxBodyBytes) {
      throw new PayloadTooLargeError(`Request body exceeds the ${maxBodyBytes}-byte limit`)
    }

    const buffer = await readCappedBody(req)

    try {
      return JSON.parse(new TextDecoder().decode(buffer))
    } catch {
      throw new BadRequestError('Body must be valid JSON')
    }
  }

  /**
   * exceedsDepth - true if a value nests deeper than `limit`. Iterative (an
   * explicit stack, not recursion) so a hostile deeply-nested document cannot
   * overflow the stack here — the very failure this guards against.
   * @param {unknown} value
   * @param {number} limit
   */
  function exceedsDepth(value, limit) {
    const stack = [[value, 1]]
    while (stack.length) {
      const [node, depth] = stack.pop()
      if (depth > limit) {
        return true
      }
      if (Array.isArray(node)) {
        for (const item of node) {
          stack.push([item, depth + 1])
        }
      } else if (isPlainObject(node)) {
        for (const key of Object.keys(node)) {
          stack.push([node[key], depth + 1])
        }
      }
    }
    return false
  }

  /**
   * mappingAdmissibility - screen a caller-supplied mapping before it reaches
   * the engine, for hazards the engine turns into opaque 500s: a mapping `$id`
   * that would corrupt a plain-object registry's prototype chain, and nesting
   * deep enough to overflow the validator's stack. Returns a report in the
   * mapper-js `{ valid, errors, warnings }` shape so callers render it exactly
   * like an engine validation report.
   * @param {object} mapping
   */
  function mappingAdmissibility(mapping) {
    const errors = []

    if (isPlainObject(mapping.mappings)) {
      for (const member of Object.values(mapping.mappings)) {
        const id = isPlainObject(member) ? member.$id : undefined
        if (typeof id === 'string' && FORBIDDEN_REGISTRY_KEYS.has(id)) {
          errors.push({ rule: 'ForbiddenKey', message: `"${id}" is not allowed as a mapping $id`, value: id })
        }
      }
    }

    if (exceedsDepth(mapping, MAX_MAPPING_DEPTH)) {
      errors.push({ rule: 'MaxDepth', message: `mapping nesting exceeds the maximum depth of ${MAX_MAPPING_DEPTH}` })
    }

    return { valid: errors.length === 0, errors, warnings: [] }
  }

  /**
   * mappingEngine - a fresh engine for one caller-supplied mapping: the
   * registered mappings plus the mapping's own family, registered ahead of
   * validation so reachability checks see exactly the registry evaluation
   * will use (the submitted mapping first, then the installed mappings). The
   * serving instance is never touched.
   * @param {object} mapping
   */
  function mappingEngine(mapping) {
    const engine = new Mapper({ mappings: mapper.mappings }, installedExtensions)

    if (isPlainObject(mapping.mappings)) {
      for (const member of Object.values(mapping.mappings)) {
        engine.add(member)
      }
    }

    return engine
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
   * runExplicitMapping - evaluate a caller-supplied mapping.
   *
   * Gate order: the capability must be enabled (`map.explicit`), the caller
   * must satisfy `map.explicit.claims`, and the mapping must validate —
   * an invalid mapping gets the full report at 422, never an evaluation
   * attempt. Evaluation is stateless: a fresh engine is built for this call
   * from the registered mappings, the submitted mapping's own family is
   * registered into it (so references resolve submitted-first, then
   * installed), and the serving instance is never touched — nothing outlives
   * the request.
   * @param {object} mapping
   * @param {unknown} input
   * @param {string} reqId
   * @param {Record<string, string>} cors
   * @param {object|null} identity
   */
  async function runExplicitMapping(mapping, input, reqId, cors, identity) {
    if (!explicitEnabled) {
      throw new ForbiddenError('The explicit mapping form is not enabled on this deployment')
    }
    if (explicitClaims && !checkClaims(identity, explicitClaims)) {
      throw new ForbiddenError('Caller lacks the claims required for explicit mappings')
    }

    // Screen for engine-crashing hazards (prototype-key $ids, over-deep nesting)
    // before the mapping reaches the engine, so they render as a 422 report
    // rather than an opaque 500.
    const admissibility = mappingAdmissibility(mapping)
    if (!admissibility.valid) {
      throw new InvalidMappingDocumentError(admissibility)
    }

    const engine = mappingEngine(mapping)

    const report = engine.validate(mapping)
    if (!report.valid) {
      throw new InvalidMappingDocumentError(report)
    }

    let result
    try {
      result = await engine.map(mapping, input, { identity })
    } catch (err) {
      classifyMapError(err)
    }
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
    const payload = await readJsonBody(req)

    const mapping = payload && payload.mapping
    const input = payload && payload.input

    if (typeof mapping === 'string') {
      if (!Object.hasOwn(mapper.mappings, mapping)) {
        throw new NotFoundError(`No mapping registered as "${mapping}"`)
      }

      let result
      try {
        result = await mapper.map(mapping, input, { identity })
      } catch (err) {
        classifyMapError(err)
      }
      return resultResponse(result, reqId, cors)
    }

    if (isPlainObject(mapping)) {
      return runExplicitMapping(mapping, input, reqId, cors, identity)
    }

    throw new BadRequestError('"mapping" must be a string naming a registered mapping, or a mapping document object')
  }

  /**
   * runHealthMapping - exercise the real mapping path: evaluate a canary
   * mapping through the full engine and report 200 only when evaluation
   * completes within `health.timeout`; otherwise 503. The canary is
   * `health.mapping` (a registered mapping id) when configured, else a
   * trivial inline echo. This exists because process liveness does not
   * imply mapping-path liveness.
   * @param {string} reqId
   * @param {Record<string, string>} cors
   */
  async function runHealthMapping(reqId, cors) {
    if (healthMapping && !Object.hasOwn(mapper.mappings, healthMapping)) {
      throw new UnavailableError(`Health canary "${healthMapping}" is not a registered mapping`)
    }

    const canary = healthMapping || { mapping: { '/echo': '/' } }

    /** @type {ReturnType<typeof setTimeout>} */
    let timer
    const expired = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new UnavailableError(`Mapping-path health check timed out after ${healthTimeout} ms`)),
        healthTimeout
      )
    })

    try {
      await Promise.race([mapper.map(canary, { health: 'check' }, {}), expired])
    } catch (err) {
      throw err instanceof ApiError ? err : new UnavailableError('Mapping-path health check failed')
    } finally {
      clearTimeout(timer)
    }

    return json({ status: 'ok' }, { reqId, cors })
  }

  /**
   * runValidate - handle `POST /validate` with a body of `{ mapping }`,
   * discriminated by type exactly like `/map`: an object is validated as a
   * caller-supplied document; a string validates an already-registered
   * mapping the same way. The response is always 200 with the full report —
   * a validation report is data, not an error, even when `valid` is false.
   * 4xx is reserved for the request itself being malformed.
   * @param {Request} req
   * @param {string} reqId
   * @param {Record<string, string>} cors
   */
  async function runValidate(req, reqId, cors) {
    const payload = await readJsonBody(req)

    const mapping = payload && payload.mapping

    if (typeof mapping === 'string') {
      if (!Object.hasOwn(mapper.mappings, mapping)) {
        throw new NotFoundError(`No mapping registered as "${mapping}"`)
      }

      return json(mapper.validate(mapper.mappings[mapping]), { reqId, cors })
    }

    if (isPlainObject(mapping)) {
      // A validation report is always 200, so an engine-crashing hazard is
      // reported as invalid rather than reaching the engine.
      const admissibility = mappingAdmissibility(mapping)
      if (!admissibility.valid) {
        return json(admissibility, { reqId, cors })
      }
      const engine = mappingEngine(mapping)
      return json(engine.validate(mapping), { reqId, cors })
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
