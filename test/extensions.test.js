/**
 * Dependencies
 */
import { assertEquals } from '@std/assert'
import mapperRequest from '@christiansmith/mapper-request'
import createServer from '../src/index.js'
import extensions from '../extensions/index.js'

/** POST a JSON body to /map. */
function mapRequest(body) {
  return new Request('http://x/map', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

Deno.test('the bundled surface lists the request plugin', async () => {
  const server = createServer({ mappings: {} }, extensions, { logging: { level: 'silent' } })
  const res = await server.fetch(new Request('http://x/extensions'))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.plugins, ['request'])
})

Deno.test('the request plugin fetches through a mapping', async () => {
  const upstream = Deno.serve({ port: 0, onListen: () => {} }, () => Response.json({ greeting: 'hello' }))
  const { port } = upstream.addr

  const mappings = {
    $id: 'test',
    mappings: {
      fetching: {
        $id: 'fetching',
        mapping: {
          '/data': { request: { origin: `http://localhost:${port}`, pathname: '/greet' } }
        }
      }
    }
  }
  const server = createServer(mappings, extensions, { logging: { level: 'silent' } })

  const res = await server.fetch(mapRequest({ mapping: 'fetching', input: {} }))
  assertEquals(res.status, 200)
  const body = await res.json()
  // The plugin returns its parse envelope: content type, the parsed body
  // under `json`, and cache stamps.
  assertEquals(body.data['content-type'], 'application/json')
  assertEquals(body.data.json.greeting, 'hello')

  await upstream.shutdown()
})

Deno.test('the request plugin resolves the url from source data', async () => {
  // A URL that arrives as data: the mapping selects it with source and
  // the plugin resolves it via url: { source } instead of authoring
  // origin/pathname in the descriptor.
  const upstream = Deno.serve({ port: 0, onListen: () => {} }, () => Response.json({ record: 'found' }))
  const { port } = upstream.addr

  const mappings = {
    $id: 'test',
    mappings: {
      resolving: {
        $id: 'resolving',
        mapping: {
          '/data': { source: '/target', request: { url: { source: '' } } }
        }
      }
    }
  }
  const server = createServer(mappings, extensions, { logging: { level: 'silent' } })

  const res = await server.fetch(
    mapRequest({ mapping: 'resolving', input: { target: `http://localhost:${port}/item/1` } })
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.data.json.record, 'found')

  await upstream.shutdown()
})

Deno.test('the strict header policy does not forward caller-supplied headers', async () => {
  // The stock plugin is built with allowHeaders: [], so a header a caller
  // writes into an explicit mapping document must not reach the upstream.
  let seenAuth = 'UNSET'
  const upstream = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    seenAuth = req.headers.get('x-forged') ?? 'ABSENT'
    return Response.json({ ok: true })
  })
  const { port } = upstream.addr

  const server = createServer({ mappings: {} }, extensions, {
    logging: { level: 'silent' },
    map: { explicit: true }
  })
  const document = {
    $id: 'exfil',
    mapping: {
      '/data': {
        request: { origin: `http://localhost:${port}`, pathname: '/', headers: { 'x-forged': 'attacker' } }
      }
    }
  }
  const res = await server.fetch(mapRequest({ mapping: document, input: {} }))
  assertEquals(res.status, 200)
  await res.body?.cancel()
  assertEquals(seenAuth, 'ABSENT')

  await upstream.shutdown()
})

/** A registry with one mapping that fetches through the request plugin. */
function fetchingMappings(port) {
  return {
    $id: 'test',
    mappings: {
      fetching: {
        $id: 'fetching',
        mapping: {
          '/data': { request: { origin: `http://localhost:${port}`, pathname: '/article' } }
        }
      }
    }
  }
}

Deno.test('a refused redirect is a 422 RedirectRefused, not a 500', async () => {
  const upstream = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { origin } = new URL(req.url)
    return new Response(null, { status: 301, headers: { location: `${origin}/article/` } })
  })
  const { port } = upstream.addr

  const server = createServer(fetchingMappings(port), extensions, { logging: { level: 'silent' } })
  const res = await server.fetch(mapRequest({ mapping: 'fetching', input: {} }))
  assertEquals(res.status, 422)
  const body = await res.json()
  assertEquals(body.code, 'RedirectRefused')
  assertEquals(body.location, `http://localhost:${port}/article/`)
  // A 4xx keeps its message even under the default minimal error detail:
  // the refusal names the URL and target, which is what the caller can fix.
  assertEquals(body.message.includes('Redirect refused'), true)

  await upstream.shutdown()
})

Deno.test('an untyped plugin failure is still a 500 with detail suppressed', async () => {
  // Port 1 refuses connections: the plugin's fetch rejects with an untyped
  // error, which must remain an InternalError — classification is surgical.
  const server = createServer(fetchingMappings(1), extensions, { logging: { level: 'silent' } })
  const res = await server.fetch(mapRequest({ mapping: 'fetching', input: {} }))
  assertEquals(res.status, 500)
  const body = await res.json()
  assertEquals(body.code, 'InternalError')
  assertEquals(body.message, 'An unexpected error occurred')
})

Deno.test('a redirecting health canary stays a 503, not a 422', async () => {
  const upstream = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { origin } = new URL(req.url)
    return new Response(null, { status: 301, headers: { location: `${origin}/article/` } })
  })
  const { port } = upstream.addr

  const server = createServer(fetchingMappings(port), extensions, {
    logging: { level: 'silent' },
    health: { mapping: 'fetching' }
  })
  const res = await server.fetch(new Request('http://x/health/mapping'))
  assertEquals(res.status, 503)
  const body = await res.json()
  assertEquals(body.code, 'Unavailable')

  await upstream.shutdown()
})

Deno.test('a follow-enabled deployment resolves the redirect and maps', async () => {
  // The doi-forge shape: a deployment opts in via its extensions module —
  // createRequest({ redirect: 'follow' }) — and a 301 to the trailing-slash
  // canonical form resolves instead of failing the batch.
  const hits = []
  const upstream = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { origin, pathname } = new URL(req.url)
    hits.push(pathname)

    if (pathname === '/article') {
      return new Response(null, { status: 301, headers: { location: `${origin}/article/` } })
    }

    return Response.json({ title: 'found' })
  })
  const { port } = upstream.addr

  const following = {
    initializers: {},
    transformers: {},
    plugins: {
      request: mapperRequest.createRequest({ allowHeaders: [], redirect: 'follow' })
    }
  }
  const server = createServer(fetchingMappings(port), following, { logging: { level: 'silent' } })
  const res = await server.fetch(mapRequest({ mapping: 'fetching', input: {} }))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.data.json.title, 'found')
  assertEquals(hits, ['/article', '/article/'])

  await upstream.shutdown()
})
