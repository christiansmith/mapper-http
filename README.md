# Mapper HTTP

> HTTP server for running Mapper mappings

`mapper-http` exposes a [Mapper](https://jsr.io/@christiansmith/mapper-js) instance
over HTTP. A deployment supplies its own **mappings** and **extensions**; the server
adds bearer-token authentication, CORS, structured logging, request-body limits, and
a small set of endpoints for running, validating, and inspecting mappings. It is
deliberately generic. It knows nothing about any particular data domain.

## Quickstart

The published image runs standalone. It serves bundled example mappings and the
stock extension surface with no configuration:

```bash
docker run -p 3333:3333 ghcr.io/christiansmith/mapper-http:0.3.0

curl -X POST localhost:3333/map \
  -H 'content-type: application/json' \
  -d '{"mapping":"greet","input":{"message":"hello"}}'
# {"text":"hello","valid":true,"errors":[]}
```

### Bring your own mappings, no image build

Mount a directory of mapping documents and point `MAPPINGS` at it:

```bash
docker run -p 3333:3333 \
  -v ./mappings:/data/mappings \
  -e MAPPINGS=/data/mappings \
  ghcr.io/christiansmith/mapper-http:0.3.0
```

### Custom images

Layer deployment assets on the stock base. No entrypoint code is involved:

```dockerfile
FROM ghcr.io/christiansmith/mapper-http:0.3.0
COPY --chown=deno:deno mappings/ /data/mappings/
COPY --chown=deno:deno extensions.js /data/extensions.js
ENV MAPPINGS=/data/mappings EXTENSIONS=/data/extensions.js
```

## Endpoints

| Method | Path              | Auth | Purpose                                   |
| ------ | ----------------- | ---- | ----------------------------------------- |
| GET    | `/health`         | no   | process liveness (cheap)                  |
| GET    | `/health/mapping` | no   | mapping-path health (canary)              |
| POST   | `/map`            | yes* | evaluate a registered or explicit mapping |
| POST   | `/validate`       | yes* | validate a document or registered mapping |
| GET    | `/mappings`       | yes* | list registered mappings                  |
| GET    | `/extensions`     | yes* | list installed extension names            |

\* when auth is configured. The write namespace `POST`/`PUT`/`DELETE /mappings/*`
is reserved for future persistence operations and returns 404 in this version.

### `POST /map`

One request key, `mapping`, discriminated by type.

**Registered form** — a string names a registered mapping:

```json
{ "mapping": "greet", "input": { "message": "hello" } }
```

An unknown id is a 404. The result is returned **as data** at 200, including its
own `valid` and `errors` fields. A deployment can promote a `valid:false` result
into a client error with `map.invalidStatus`.

**Explicit form** — an object is a caller-supplied mapping document (a single
descriptor or a compound document whose members travel together):

```json
{
  "mapping": {
    "$id": "greet",
    "mappings": {
      "greet": { "$id": "greet", "mapping": { "/text": "/message" } }
    }
  },
  "input": { "message": "hello" }
}
```

The explicit form is **off by default**. Enable it with `map.explicit`, and gate
it separately with `map.explicit.claims`. A submitted document is validated
before evaluation; an invalid document returns 422 with the full validation
report and is never evaluated. Evaluation is stateless: references resolve
against the document first, then the installed registry, and nothing a caller
submits registers into the server or is observable to any other request.

Any other type for `mapping`, or a missing `mapping`, is a 400.

### `POST /validate`

Instance-level validation with the same type discrimination as `/map`: an
object validates a caller-supplied document against this instance, including
referential reachability (do the referenced transformer names, plugin keys, and
`$ref` targets exist here?); a string validates an already-registered mapping
the same way. The response is always 200 with the full report
(`valid`, `errors`, `warnings`), even when `valid` is false. A validation
report is data, not an error. 4xx is reserved for the request itself being
malformed.

### `GET /mappings`

The registered mappings. Explicit submissions never appear here.

### `GET /extensions`

The installed extension surface a mapping author writes against:

```json
{ "initializers": [], "transformers": [], "plugins": ["request"] }
```

Names only. Never configuration, code, or values.

### `GET /health` and `GET /health/mapping`

`/health` is cheap process liveness. `/health/mapping` evaluates a canary
mapping through the full engine and reports 200 only when evaluation completes
within `health.timeout` (default 5000 ms); otherwise 503. The canary is
`health.mapping` (a registered mapping id) when configured, else a trivial
echo. Process liveness does not imply mapping-path liveness; the container
`HEALTHCHECK` targets this endpoint. Health endpoints are unauthenticated, so
choose a cheap canary without side effects.

## Configuration

### Environment

| Variable       | Meaning                                                                 | Default                  |
| -------------- | ----------------------------------------------------------------------- | ------------------------ |
| `PORT`         | listen port                                                              | `3333`                   |
| `MAPPINGS`     | mapping source: module path, document file, or directory                 | bundled examples         |
| `EXTENSIONS`   | module path exporting extensions                                         | bundled surface          |
| `OPTIONS`      | the full options object as JSON                                          | `{}`                     |
| `OPTIONS_FILE` | path to a file holding the options object (`.json`, `.yaml`, `.yml`)     | unset                    |

`PORT`/`MAPPINGS`/`EXTENSIONS` are bootstrap; `OPTIONS` (or `OPTIONS_FILE`) is
the canonical channel for everything `createServer` accepts. There are no
per-option environment variables. Setting both `OPTIONS` and `OPTIONS_FILE`, or
supplying a value that does not parse, fails startup loudly.

### Mapping sources

`MAPPINGS` accepts three forms, discriminated by what the path is:

1. **Module path** (`.js`/`.ts`) — the module's default export is the mappings
   descriptor.
2. **Document file** (`.json`, `.yaml`, `.yml`) — the file is one mapping
   document: a descriptor object or a compound document.
3. **Directory** — scanned recursively for document files in lexicographic path
   order. Every mapping they contain is registered by its `$id`. The same `$id`
   from two files is a startup error naming both files; non-document files are
   ignored with a warning.

`EXTENSIONS` is a module path in all cases: extensions are code.

### Options

The options object, via `OPTIONS`/`OPTIONS_FILE` or `createServer`:

- `auth` — one key strategy plus optional constraints. Omit to disable auth.
  - `secret` (HS256) **or** `publicKey` (SPKI PEM; RS256/ES256/EdDSA) **or**
    `jwksUri` (asymmetric, with kid resolution and caching).
  - `algorithm` — a single algorithm or an allowlist. Defaults to `HS256` for a
    secret, and `RS256, ES256, EdDSA` (no HMAC, preventing algorithm confusion)
    for a public key or JWKS.
  - `issuer`, `audience` — expected claims. `clockSkew` — tolerance in seconds.
- `cors` — `{ origin, methods, headers }`. Omit to disable CORS. Bearer-only:
  credentials are not enabled.
- `logging` — `{ format: 'json' | 'pretty', level, slowThreshold }`. One
  structured line per request; `Authorization` is always redacted.
- `errorDetail` — `'minimal'` (default) or `'full'`. In `minimal`, 5xx detail is
  replaced with a generic message; the full error is logged server-side.
- `maxBodyBytes` — reject larger request bodies with 413 (default 1 MiB).
- `requestIdPrefix` — prefix for generated request ids (default `req_`).
- `map` — `{ invalidStatus?, claims?, explicit? }`. `claims` gates `POST /map`;
  `explicit` enables the explicit form (`true`, or `{ claims }` to gate it
  separately — checked in addition to `map.claims`).
- `validate` — `{ claims? }` gates `POST /validate`.
- `health` — `{ mapping?, timeout? }` canary configuration for
  `GET /health/mapping`.

Per-capability claims let an operator run "registered mappings only" (explicit
disabled), "explicit for these callers" (claims on the explicit form), or
"validate but never evaluate" (validation claims granted, explicit off) — that
last posture is how an agent can propose, validate, and repair mappings against
a live instance without evaluation rights.

## Extensions

An extension surface is a module whose default export is
`{ initializers, transformers, plugins }` — the functions a mapping author can
call by name. `GET /extensions` lists the names installed on a running server.

- **initializers** produce a value from their descriptor (e.g. a generated id).
- **transformers** map a value to a new value inside a `transform` pipeline.
- **plugins** are async resolvers keyed by name (e.g. `request`), invoked when a
  mapping descriptor carries that key.

See the [mapper-js](https://jsr.io/@christiansmith/mapper-js) documentation for
the full extension contract — the exact function signatures and the async and
purity rules. The stock surface bundles the `request` plugin from
[mapper-request](https://jsr.io/@christiansmith/mapper-request): mappings fetch
remote sources with a `request` descriptor, and the plugin returns its parse
envelope (content type, the parsed body under `json`, and cache stamps), so
mappings address the payload under `/json`.

### Following redirects

The stock `request` plugin refuses every redirect: a 3xx response fails the
mapping with a `422 RedirectRefused` error naming the target in `location`.
That default is right for untrusted mappings, but many publishers 301 every
URL to a canonical form (most commonly adding a trailing slash), which makes
refusal fail resolvable URLs. A deployment can opt in to bounded following in
its extensions module:

```js
// extensions.js
import mapperRequest from '@christiansmith/mapper-request'

export default {
  initializers: {},
  transformers: {},
  plugins: {
    request: mapperRequest.createRequest({ allowHeaders: [], redirect: 'follow' })
  }
}
```

Following is deliberately narrow: GET requests only, at most `maxRedirects`
hops (default 2), targets restricted to the same origin plus the http→https
upgrade of the identical hostname on default ports (`redirectHttpsUpgrade`,
default `true`; the downgrade direction never follows), and every redirect
target re-passes the deployment's `checkUrl` policy hook before it is
fetched — destination policy holds across a chain exactly as for a directly
submitted URL. See the
[mapper-request changelog](https://jsr.io/@christiansmith/mapper-request)
for the full option reference.

### A custom surface

An `EXTENSIONS` module is plain code:

```js
// extensions.js
export default {
  initializers: {
    uuid: () => crypto.randomUUID()
  },
  transformers: {
    shout: (value) => String(value).toUpperCase()
  },
  plugins: {}
}
```

A mapping can then initialize with `uuid` and use `shout` in a `transform`.

### Replacing vs. extending the stock surface

Setting `EXTENSIONS` **replaces** the bundled surface entirely — including the
stock `request` plugin. To keep `request` alongside your own extensions,
re-export it:

```js
// extensions.js
import mapperRequest from '@christiansmith/mapper-request'

export default {
  initializers: { uuid: () => crypto.randomUUID() },
  transformers: { shout: (value) => String(value).toUpperCase() },
  plugins: {
    request: mapperRequest.createRequest({ allowHeaders: [] })
  }
}
```

(A fully-qualified `jsr:@christiansmith/mapper-request@^0.2.0` import works too,
and is a touch more robust than the bare specifier.)

### In a custom image

The module is what the custom-image recipe copies in — `EXTENSIONS` is a module
path in all cases, because extensions are code:

```dockerfile
FROM ghcr.io/christiansmith/mapper-http:0.3.0
COPY --chown=deno:deno extensions.js /data/extensions.js
COPY --chown=deno:deno mappings/ /data/mappings/
ENV EXTENSIONS=/data/extensions.js MAPPINGS=/data/mappings
```

## Library usage (Deno)

```js
import createServer, { loadMappings } from '@christiansmith/mapper-http'

const mappings = await loadMappings('./mappings')
const server = createServer(mappings, extensions, {
  auth: { jwksUri: 'https://issuer.example/.well-known/jwks.json' },
  logging: { format: 'json' },
  map: { explicit: { claims: { role: ['author'] } } }
})

server.listen({ port: 3333 })
```

## Errors

Server errors are returned as
`{ "code": "<Code>", "message": "<message>", "requestId": "<id>" }` with status
codes 400, 401, 403, 404, 405, 413, 422, 500, and 503. A 422
`InvalidMappingDocument` carries the full validation report under `report`;
a `ValidationError` from `map.invalidStatus` carries the mapping's `errors`.
Every response carries an `X-Request-Id` header. Mapping results — including
`valid: false` results — are data at 200, not errors.

## Development

```bash
deno task dev     # bundled examples on :3333, CORS open, pretty logs, no auth
deno task test    # the test suite
./test/smoke.sh   # build the image and smoke it end to end
```

The dev workflow and the container run the same entrypoint with defaulted
environment.

## License

MIT © Christian Smith
