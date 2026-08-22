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
