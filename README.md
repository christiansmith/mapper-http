# Mapper HTTP

> HTTP server for running Mapper mappings

`mapper-http` exposes a [Mapper](https://jsr.io/@christiansmith/mapper-js) instance
over HTTP. A deployment supplies its own **mappings** and **extensions**; the server
provides bearer-token authentication, CORS, and a small set of endpoints for running
mappings. It is deliberately generic — it knows nothing about any particular data
domain.

## Status

Minimal MVP: JWT (bearer) authentication, CORS, and a generic mapping endpoint.
Declarative per-route bindings (a `routes` config) and request-envelope
materialization are planned.

## Usage (Deno)

```js
import createServer from '@christiansmith/mapper-http'

const server = createServer(mappings, extensions, {
  cors: { origin: ['https://example.org'] },
  auth: {
    jwksUri: 'https://issuer.example/.well-known/jwks.json',
    issuer: 'https://issuer.example',
    audience: 'mapper-http'
  }
})

server.listen({ port: 3333 })
```

Run the bundled example:

```bash
deno task dev      # serves an echo mapping on :3333, CORS open, no auth
deno task test
```

## API

### `POST /map`

Run a registered mapping over a supplied input (the generic escape hatch).

```json
{ "mapping": "<mapping-id>", "input": <any> }
```

Returns the mapper result. When the mapper reports validation errors the response
is `422` with `{ "error": "unprocessable", "errors": [ ... ] }`.

### `GET /mappings`

List the registered mappings.

### `GET /health`

Liveness check (unauthenticated): `{ "status": "ok" }`.

## Configuration

`createServer(mappings, extensions, options)`

- `mappings` — a Mapper descriptor (`{ $id, mappings }`).
- `extensions` — `{ initializers, transformers, plugins }`.
- `options.auth` — `{ jwksUri, issuer, audience }`. Omit to disable auth (local dev).
- `options.cors` — `{ origin, methods, headers }`. `origin` may be `'*'`, a string, or
  an array. Omit to disable CORS. Bearer-only: credentials are not enabled.

## Errors

Errors are returned as `{ "error": "<code>", "detail": "<message>" }` with status
codes `400`, `401`, `404`, `405`, `422`, and `500`.

## License

MIT © Christian Smith
