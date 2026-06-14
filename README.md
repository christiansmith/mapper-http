# Mapper HTTP

> HTTP server for running Mapper mappings

`mapper-http` exposes a [Mapper](https://jsr.io/@christiansmith/mapper-js) instance
over HTTP. A deployment supplies its own **mappings** and **extensions**; the server
provides bearer-token authentication, CORS, and a small set of endpoints for running
mappings. It is deliberately generic — it knows nothing about any particular data
domain.

## Status

JWT (bearer) authentication with an algorithm allowlist, CORS, structured
logging, request ids, body-size limits, and a generic mapping endpoint.
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
  },
  logging: { format: 'json' },
  map: { invalidStatus: 422 }
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

Returns the mapper result **as data**, at `200` — including its own `valid` and
`errors` fields for the caller to inspect. A mapping's validation state is not a
transport error by default. A deployment that uses a mapping to validate the
request body can opt to promote a `valid:false` result into a client error with
`map.invalidStatus` (see Configuration); the response is then a
`ValidationError` envelope carrying the mapping's `errors`.

### `GET /mappings`

List the registered mappings.

### `GET /health`

Liveness check (unauthenticated): `{ "status": "ok" }`.

## Configuration

`createServer(mappings, extensions, options)`

- `mappings` — a Mapper descriptor (`{ $id, mappings }`).
- `extensions` — `{ initializers, transformers, plugins }`.
- `options.auth` — one key strategy plus optional constraints. Omit to disable
  auth (local dev).
  - `secret` (HS256) **or** `publicKey` (SPKI PEM; RS256/ES256/EdDSA) **or**
    `jwksUri` (asymmetric, with kid resolution + caching).
  - `algorithm` — a single algorithm or an allowlist (array, or comma-separated
    string). Defaults to `HS256` for a secret, and `RS256, ES256, EdDSA` (no
    HMAC, to prevent algorithm confusion) for a public key or JWKS.
  - `issuer`, `audience` — expected claims (string or array). `clockSkew` —
    tolerance in seconds.
- `options.cors` — `{ origin, methods, headers }`. `origin` may be `'*'`, a string, or
  an array. Omit to disable CORS. Bearer-only: credentials are not enabled.
- `options.logging` — `{ format: 'json' | 'pretty', level, slowThreshold }`.
  Defaults to JSON at `info`. One structured line per request (method, path,
  status, duration); `Authorization` is always redacted.
- `options.errorDetail` — `'minimal'` (default) or `'full'`. In `minimal`, 5xx
  detail is replaced with a generic message to the client and the full error is
  logged server-side; 4xx messages are always returned.
- `options.maxBodyBytes` — reject larger request bodies with `413` (default 1 MiB).
- `options.requestIdPrefix` — prefix for generated request ids (default `req_`).
- `options.map` — `{ invalidStatus?, claims? }`. `invalidStatus` promotes a
  mapping's `valid:false` result into a `ValidationError` at that status (e.g.
  `422`); unset, the result is returned as data at `200`. `claims` gates
  `POST /map` (e.g. `{ role: ['admin'] }` → `403` without it).

## Errors

Server errors are returned as `{ "code": "<Code>", "message": "<message>", "requestId": "<id>" }`
(validation errors add an `errors` array) with status codes `400`, `401`,
`403`, `404`, `405`, `413`, `422`, and `500`. Every response — success or
error — carries an `X-Request-Id` header.

## License

MIT © Christian Smith
