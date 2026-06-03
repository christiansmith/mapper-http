/**
 * Dependencies
 */
import { assertEquals } from '@std/assert'
import createServer from '../src/index.js'

/**
 * A server with a trivial echo mapping, CORS open, no auth.
 */
function testServer() {
  const mappings = {
    $id: 'test',
    mappings: {
      echo: { $id: 'echo', mapping: { '/echo': '/' } }
    }
  }

  return createServer(mappings, {}, { cors: { origin: '*' } })
}

Deno.test('GET /health returns ok', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/health'))
  assertEquals(res.status, 200)
  assertEquals((await res.json()).status, 'ok')
})

Deno.test('unknown route returns 404', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/nope'))
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('GET /mappings lists registered mappings', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/mappings'))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(typeof body.echo, 'object')
})

Deno.test('POST /map runs a mapping', async () => {
  const server = testServer()
  const res = await server.fetch(
    new Request('http://x/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapping: 'echo', input: { hello: 'world' } })
    })
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.valid !== false, true)
})

Deno.test('POST /map without a mapping is 400', async () => {
  const server = testServer()
  const res = await server.fetch(
    new Request('http://x/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} })
    })
  )
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('wrong method on /map is 405', async () => {
  const server = testServer()
  const res = await server.fetch(new Request('http://x/map'))
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const server = testServer()
  const res = await server.fetch(
    new Request('http://x/map', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' }
    })
  )
  assertEquals(res.status, 204)
  assertEquals(res.headers.get('access-control-allow-origin'), '*')
})
