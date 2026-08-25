/**
 * Dependencies
 */
import { assertEquals } from '@std/assert'
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
