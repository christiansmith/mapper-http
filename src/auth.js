/**
 * JWT Bearer authentication and flat claim-based authorization.
 *
 * Built on jose. Supports three key strategies — a static HMAC secret (HS256),
 * a static public key (RS256/ES256/EdDSA), and a JWKS endpoint (asymmetric,
 * with kid resolution + caching, handled by jose). Authentication is disabled
 * when no strategy is configured (local dev).
 *
 * `algorithm` may be a single value or an allowlist (array, or a
 * comma-separated string), which is what a JWKS that rotates across algorithms
 * needs. Tokens signed with an algorithm outside the allowlist are rejected —
 * this is what prevents algorithm-confusion attacks.
 */
import { createRemoteJWKSet, importSPKI, jwtVerify } from 'jose'
import { UnauthorizedError } from './errors.js'

/** @typedef {{ algorithm?: string|string[], secret?: string, publicKey?: string, jwksUri?: string, issuer?: string|string[], audience?: string|string[], clockSkew?: number }} AuthConfig */

/**
 * Resolve the allowed signing algorithms. Defaults to HS256 for a shared
 * secret, and the asymmetric set (no HMAC, to prevent algorithm confusion) for
 * a public key or JWKS.
 * @param {AuthConfig} config
 * @returns {string[]}
 */
function algorithmsFor(config) {
  const a = config.algorithm
  if (Array.isArray(a)) {
    return a
  }
  if (typeof a === 'string' && a.trim()) {
    return a
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return config.secret ? ['HS256'] : ['RS256', 'ES256', 'EdDSA']
}

/**
 * Build a JWT authenticator, or `null` when authentication is disabled (no key
 * strategy configured). The returned function verifies the request's Bearer
 * token and resolves to its decoded claims, or throws UnauthorizedError.
 *
 * Key material is resolved lazily (and memoized) on first use, so this factory
 * stays synchronous even for the static-public-key strategy (which needs an
 * async `importSPKI`).
 * @param {AuthConfig} config
 * @returns {((req: Request) => Promise<Record<string, unknown>>) | null}
 */
export function createAuthenticator(config) {
  if (!config.secret && !config.publicKey && !config.jwksUri) {
    return null
  }
  const algorithms = algorithmsFor(config)

  /** @type {Promise<any> | null} */
  let keyPromise = null
  function resolveKey() {
    if (!keyPromise) {
      if (config.jwksUri) {
        keyPromise = Promise.resolve(createRemoteJWKSet(new URL(config.jwksUri)))
      } else if (config.publicKey) {
        // A static public key has a single algorithm; use the first listed.
        keyPromise = importSPKI(config.publicKey, algorithms[0])
      } else {
        keyPromise = Promise.resolve(new TextEncoder().encode(config.secret))
      }
    }
    return keyPromise
  }

  /** @type {Record<string, unknown>} */
  const options = { algorithms }
  if (config.issuer) {
    options.issuer = config.issuer
  }
  if (config.audience) {
    options.audience = config.audience
  }
  if (config.clockSkew) {
    options.clockTolerance = config.clockSkew
  }

  return async function authenticate(req) {
    const header = req.headers.get('authorization') || ''
    const match = header.match(/^Bearer (.+)$/i)
    if (!match) {
      throw new UnauthorizedError('Missing bearer token')
    }
    const key = await resolveKey()
    try {
      const { payload } = await jwtVerify(match[1], key, options)
      return payload
    } catch (err) {
      throw toUnauthorized(err)
    }
  }
}

/**
 * Map a jose verification error to a clean 401 message.
 * @param {any} err
 */
function toUnauthorized(err) {
  const code = err && err.code
  if (code === 'ERR_JWT_EXPIRED') {
    return new UnauthorizedError('Token expired')
  }
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
    return new UnauthorizedError('Invalid token signature')
  }
  if (code === 'ERR_JOSE_ALG_NOT_ALLOWED') {
    return new UnauthorizedError('Unsupported algorithm')
  }
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    if (err.claim === 'iss') {
      return new UnauthorizedError('Invalid issuer')
    }
    if (err.claim === 'aud') {
      return new UnauthorizedError('Invalid audience')
    }
    if (err.claim === 'nbf') {
      return new UnauthorizedError('Token not yet valid')
    }
  }
  return new UnauthorizedError('Malformed token')
}

/**
 * Flat claim-matching authorization. Every configured claim must be satisfied:
 * the caller's value must be (or include) one of the allowed values.
 * @param {Record<string, unknown>|null} claims decoded JWT payload
 * @param {Record<string, unknown>} required e.g. `{ role: ['admin'] }`
 * @returns {boolean}
 */
export function checkClaims(claims, required) {
  if (!claims) {
    return false
  }
  for (const [name, allowedValue] of Object.entries(required)) {
    const allowed = Array.isArray(allowedValue) ? allowedValue : [allowedValue]
    const actual = claims[name]
    const actualValues = Array.isArray(actual) ? actual : [actual]
    if (!actualValues.some((value) => allowed.includes(value))) {
      return false
    }
  }
  return true
}
