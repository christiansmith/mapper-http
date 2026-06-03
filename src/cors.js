/**
 * resolveOrigin
 *
 * Reflect the request Origin when it is allowed. `*` allows any origin.
 *
 * @param {Request} req
 * @param {string|string[]} allowed
 * @returns {string|null}
 */
function resolveOrigin(req, allowed) {
  if (allowed === '*' || allowed == null) {
    return '*'
  }

  const origin = req.headers.get('origin')
  const list = Array.isArray(allowed) ? allowed : [allowed]

  return list.includes(origin) ? origin : null
}

/**
 * corsHeaders
 *
 * Headers to merge into a response. Bearer-only: credentials are not allowed.
 *
 * @param {Request} req
 * @param {object|null} cors - { origin, methods, headers }
 * @returns {Record<string, string>}
 */
function corsHeaders(req, cors) {
  if (!cors) {
    return {}
  }

  const origin = resolveOrigin(req, cors.origin)

  if (!origin) {
    return {}
  }

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': cors.methods || 'GET, POST, OPTIONS',
    'access-control-allow-headers': cors.headers || 'authorization, content-type',
    vary: 'origin'
  }
}

/**
 * preflight
 *
 * Respond to a CORS preflight (OPTIONS) request.
 *
 * @param {Request} req
 * @param {object|null} cors
 * @returns {Response}
 */
function preflight(req, cors) {
  return new Response(null, { status: 204, headers: corsHeaders(req, cors) })
}

export { corsHeaders, preflight }
