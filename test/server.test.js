/**
 * Dependencies
 */
import { assertEquals } from '@std/assert'
import { SignJWT } from 'jose'
import createServer from '../src/index.js'

/**
 * A server with a trivial echo mapping, CORS open, no auth. Logging is
 * silenced so tests don't print a line per request.
 * @param {object} [extra] extra createServer options, merged in
 */
function testServer(extra) {
  const mappings = {
    $id: 'test',
    mappings: {
      echo: { $id: 'echo', mapping: { '/echo': '/' } }
    }
  }

  return createServer(mappings, {}, { cors: { origin: '*' }, logging: { level: 'silent' }, ...extra })
}

/** POST a JSON body to /map. */
function mapRequest(body, headers) {
  return new Request('http://x/map', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}

Deno.test('GET /health returns ok', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/health'))
  assertEquals(res.status, 200)
  assertEquals((await res.json()).status, 'ok')
})

Deno.test('every response carries an X-Request-Id', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/health'))
  const id = res.headers.get('x-request-id')
  assertEquals(typeof id, 'string')
  assertEquals(id.startsWith('req_'), true)
  await res.body?.cancel()
})

Deno.test('unknown route returns a typed 404 envelope', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/nope'))
  assertEquals(res.status, 404)
  const body = await res.json()
  assertEquals(body.code, 'NotFound')
  assertEquals(typeof body.message, 'string')
  assertEquals(typeof body.requestId, 'string')
})

Deno.test('GET /mappings lists registered mappings', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/mappings'))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(typeof body.echo, 'object')
})

Deno.test('POST /map runs a mapping and returns the result as data', async () => {
  const server = testServer()
  const res = await server.fetch(mapRequest({ mapping: 'echo', input: { hello: 'world' } }))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.valid !== false, true)
  assertEquals(body.echo.hello, 'world')
})

Deno.test('POST /map without a mapping is a typed 400', async () => {
  const server = testServer()
  const res = await server.fetch(mapRequest({ input: {} }))
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.code, 'BadRequest')
})

Deno.test('malformed JSON body is a 400', async () => {
  const server = testServer()
  const res = await server.fetch(
    new Request('http://x/map', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json' })
  )
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.code, 'BadRequest')
})

Deno.test('oversized body is rejected with 413', async () => {
  const server = testServer({ maxBodyBytes: 16 })
  const res = await server.fetch(mapRequest({ mapping: 'echo', input: { lots: 'of data here please' } }))
  assertEquals(res.status, 413)
  const body = await res.json()
  assertEquals(body.code, 'PayloadTooLarge')
})

Deno.test('wrong method on /map is 405', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/map'))
  assertEquals(res.status, 405)
  const body = await res.json()
  assertEquals(body.code, 'MethodNotAllowed')
})

Deno.test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/map', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } }))
  assertEquals(res.status, 204)
  assertEquals(res.headers.get('access-control-allow-origin'), '*')
})

// --- the bridge: map.invalidStatus ---

/** A mapping whose validation fails when `name` is not a string. */
function validatingServer(extra) {
  const mappings = {
    $id: 'test',
    mappings: {
      strict: {
        $id: 'strict',
        mapping: { '/name': { source: '/name', type: 'string' } }
      }
    }
  }
  return createServer(mappings, {}, { logging: { level: 'silent' }, ...extra })
}

Deno.test('by default a valid:false result is returned as data at 200', async () => {
  const server = validatingServer()
  const res = await server.fetch(
    new Request('http://x/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapping: 'strict', input: { name: 42 } })
    })
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.valid, false)
})

Deno.test('map.invalidStatus promotes valid:false to a ValidationError', async () => {
  const server = validatingServer({ map: { invalidStatus: 422 } })
  const res = await server.fetch(
    new Request('http://x/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapping: 'strict', input: { name: 42 } })
    })
  )
  assertEquals(res.status, 422)
  const body = await res.json()
  assertEquals(body.code, 'ValidationError')
  assertEquals(Array.isArray(body.errors), true)
})

// --- auth: HS256 + algorithm allowlist ---

const SECRET = 'test-secret-value'

/** Mint an HS256 token signed with SECRET. */
async function token(claims = {}) {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET))
}

Deno.test('a protected route rejects a missing token with 401', async () => {
  const server = testServer({ auth: { secret: SECRET } })
  const res = await server.fetch(mapRequest({ mapping: 'echo', input: {} }))
  assertEquals(res.status, 401)
  const body = await res.json()
  assertEquals(body.code, 'Unauthorized')
})

Deno.test('a protected route accepts a valid HS256 token', async () => {
  const server = testServer({ auth: { secret: SECRET } })
  const jwt = await token()
  const res = await server.fetch(mapRequest({ mapping: 'echo', input: { hello: 'world' } }, { authorization: `Bearer ${jwt}` }))
  assertEquals(res.status, 200)
  await res.body?.cancel()
})

Deno.test('health stays unauthenticated even when auth is configured', async () => {
  const server = testServer({ auth: { secret: SECRET } })
  const res = await server.fetch(new Request('http://x/health'))
  assertEquals(res.status, 200)
  await res.body?.cancel()
})

Deno.test('claim gate forbids tokens without the required claim', async () => {
  const server = testServer({ auth: { secret: SECRET }, map: { claims: { role: ['admin'] } } })
  const jwt = await token({ role: 'user' })
  const res = await server.fetch(mapRequest({ mapping: 'echo', input: {} }, { authorization: `Bearer ${jwt}` }))
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.code, 'Forbidden')
})

Deno.test('claim gate admits tokens with the required claim', async () => {
  const server = testServer({ auth: { secret: SECRET }, map: { claims: { role: ['admin'] } } })
  const jwt = await token({ role: 'admin' })
  const res = await server.fetch(mapRequest({ mapping: 'echo', input: { hello: 'world' } }, { authorization: `Bearer ${jwt}` }))
  assertEquals(res.status, 200)
  await res.body?.cancel()
})

Deno.test('a token signed with a disallowed algorithm is rejected', async () => {
  const server = testServer({ auth: { secret: SECRET, algorithm: ['HS384'] } })
  const jwt = await token()
  const res = await server.fetch(mapRequest({ mapping: 'echo', input: {} }, { authorization: `Bearer ${jwt}` }))
  assertEquals(res.status, 401)
  await res.body?.cancel()
})
