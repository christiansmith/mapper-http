/**
 * Example runner for local development.
 *
 *   deno task dev
 *
 * Serves a trivial `echo` mapping with CORS open and no authentication.
 */
import createServer from './src/index.js'

const mappings = {
  $id: 'example',
  mappings: {
    echo: {
      $id: 'echo',
      mapping: {
        '/echo': '/'
      }
    }
  }
}

const server = createServer(mappings, {}, {
  cors: { origin: '*' },
  logging: { format: 'pretty' }
})

server.listen({ port: 3333 })
console.log('mapper-http listening on http://localhost:3333')
