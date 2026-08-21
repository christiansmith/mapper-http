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

// --- POST /map: type discrimination and the explicit form ---

/** A compound document carrying one `greet` mapping. */
const greetDocument = {
  $id: 'greet',
  mappings: {
    greet: { $id: 'greet', mapping: { '/text': '/message' } }
  }
}

Deno.test('a string naming an unregistered mapping is a 404', async () => {
  const server = testServer()
  const res = await server.fetch(mapRequest({ mapping: 'nope', input: {} }))
  assertEquals(res.status, 404)
  const body = await res.json()
  assertEquals(body.code, 'NotFound')
})

Deno.test('a mapping that is neither string nor object is a 400', async () => {
  const server = testServer()
  const res = await server.fetch(mapRequest({ mapping: 42, input: {} }))
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.code, 'BadRequest')
})

Deno.test('an array-valued mapping is a 400', async () => {
  const server = testServer()
  const res = await server.fetch(mapRequest({ mapping: ['echo'], input: {} }))
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.code, 'BadRequest')
})

Deno.test('an object mapping is 403 when the explicit form is not enabled', async () => {
  const server = testServer()
  const res = await server.fetch(mapRequest({ mapping: greetDocument, input: { message: 'hello' } }))
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.code, 'Forbidden')
})

Deno.test('an explicit compound document evaluates when enabled', async () => {
  const server = testServer({ map: { explicit: true } })
  const res = await server.fetch(mapRequest({ mapping: greetDocument, input: { message: 'hello' } }))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.text, 'hello')
})

Deno.test('an explicit single descriptor evaluates when enabled', async () => {
  const server = testServer({ map: { explicit: true } })
  const res = await server.fetch(mapRequest({ mapping: { mapping: { '/text': '/message' } }, input: { message: 'hi' } }))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.text, 'hi')
})

Deno.test('an invalid explicit document is a 422 with the full report', async () => {
  const server = testServer({ map: { explicit: true } })
  const res = await server.fetch(mapRequest({ mapping: { mapping: 42 }, input: {} }))
  assertEquals(res.status, 422)
  const body = await res.json()
  assertEquals(body.code, 'InvalidMappingDocument')
  assertEquals(body.report.valid, false)
  assertEquals(Array.isArray(body.report.errors), true)
  assertEquals(Array.isArray(body.report.warnings), true)
})

Deno.test('an explicit document may reference installed mappings', async () => {
  const server = testServer({ map: { explicit: true } })
  const document = {
    $id: 'caller',
    mappings: {
      caller: { $id: 'caller', mapping: { '/inner': 'echo' } }
    }
  }
  const res = await server.fetch(mapRequest({ mapping: document, input: { message: 'hi' } }))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.inner.echo.message, 'hi')
})

Deno.test('an explicit submission never registers into the serving instance', async () => {
  const server = testServer({ map: { explicit: true } })
  const res = await server.fetch(mapRequest({ mapping: greetDocument, input: { message: 'hello' } }))
  assertEquals(res.status, 200)
  await res.body?.cancel()

  const listed = await server.fetch(new Request('http://x/mappings'))
  const body = await listed.json()
  assertEquals('greet' in body, false)
})

Deno.test('a document shadows a registered mapping for its own request only', async () => {
  const server = testServer({ map: { explicit: true } })
  const shadow = {
    $id: 'shadow',
    mappings: {
      echo: { $id: 'echo', mapping: { '/shadowed': '/message' } }
    }
  }
  const explicit = await server.fetch(mapRequest({ mapping: shadow, input: { message: 'hi' } }))
  assertEquals((await explicit.json()).shadowed, 'hi')

  const registered = await server.fetch(mapRequest({ mapping: 'echo', input: { message: 'hi' } }))
  const body = await registered.json()
  assertEquals(body.echo.message, 'hi')
  assertEquals(body.shadowed, undefined)
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

Deno.test('explicit claims forbid callers without them, beyond map claims', async () => {
  const server = testServer({
    auth: { secret: SECRET },
    map: { claims: { role: ['user', 'admin'] }, explicit: { claims: { role: ['admin'] } } }
  })
  const jwt = await token({ role: 'user' })
  const res = await server.fetch(mapRequest({ mapping: greetDocument, input: { message: 'hello' } }, { authorization: `Bearer ${jwt}` }))
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.code, 'Forbidden')
})

Deno.test('explicit claims admit callers that satisfy them', async () => {
  const server = testServer({
    auth: { secret: SECRET },
    map: { claims: { role: ['user', 'admin'] }, explicit: { claims: { role: ['admin'] } } }
  })
  const jwt = await token({ role: 'admin' })
  const res = await server.fetch(mapRequest({ mapping: greetDocument, input: { message: 'hello' } }, { authorization: `Bearer ${jwt}` }))
  assertEquals(res.status, 200)
  assertEquals((await res.json()).text, 'hello')
})

Deno.test('a token signed with a disallowed algorithm is rejected', async () => {
  const server = testServer({ auth: { secret: SECRET, algorithm: ['HS384'] } })
  const jwt = await token()
  const res = await server.fetch(mapRequest({ mapping: 'echo', input: {} }, { authorization: `Bearer ${jwt}` }))
  assertEquals(res.status, 401)
  await res.body?.cancel()
})
