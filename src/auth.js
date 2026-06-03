/**
 * Dependencies
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * createVerifier
 *
 * Build a bearer-token verifier backed by a remote JWK Set. The JWKS is
 * fetched on demand and refreshed on key rotation by `jose`.
 *
 * @param {object} config
 * @param {string} config.jwksUri - URL of the issuer's JWK Set
 * @param {string} [config.issuer] - expected `iss` claim
 * @param {string} [config.audience] - expected `aud` claim
 * @returns {(token: string) => Promise<object>} resolves the validated claims
 */
function createVerifier(config) {
  const { jwksUri, issuer, audience } = config

  if (!jwksUri) {
    throw new Error('createVerifier requires a jwksUri')
  }

  const jwks = createRemoteJWKSet(new URL(jwksUri))

  return async function verify(token) {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience })
    return payload
  }
}

export default createVerifier
