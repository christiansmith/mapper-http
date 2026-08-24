# Mapper HTTP Specification

This document specifies mapper-http 0.3.0. It is written to stand alone; differences from the previous release are consolidated in Appendix A.

## 1. Overview

### 1.1 What this is

mapper-http exposes a Mapper instance over HTTP. A deployment supplies its own mappings and extensions; the server adds authentication, CORS, structured logging, request-body limits, and a small set of endpoints for running, validating, and inspecting mappings.

**Registered mappings** are the instance's mapping set, loaded at startup from wherever the deployment sources them — bundled defaults, a mounted file or directory, or a custom image layer. This specification deliberately says _loaded at startup_, not _baked into the image_: how the set is sourced is a deployment concern, and future versions may add managed persistence (§8).

Callers may also supply a mapping document with a request ("explicit" mappings, §3.2), when the deployment enables it. The server ships as a published Docker image that runs standalone with bundled defaults.

### 1.2 Key design decisions

1. **The server is generic.** Deployment specificity arrives as configuration (mappings, extensions, options), never as server code. The stock image runs with bundled defaults; custom images layer on top of it.
2. **Two planes of errors.** Server errors (bad JSON, auth, routing, limits) render as `{ code, message, requestId }`. Mapping results are data at 200, including `valid: false` results, unless the deployment opts into `map.invalidStatus`.
3. **Explicit mapping evaluation is stateless.** A caller-supplied document is evaluated against the installed registry plus the document's own mappings, and nothing persists. Two requests with the same registered mappings and inputs return the same results regardless of what any other caller submitted. Implementation: a fresh engine instance per explicit call; the serving instance is never touched.
4. **Document validity gates evaluation for explicit documents.** An invalid submitted document produces the full validation report, not an evaluation attempt.
5. **Capabilities are individually gate-able.** Registered-mapping evaluation, explicit-mapping evaluation, and validation can each require their own claims; explicit evaluation is off unless enabled.

### 1.3 Technology

Deno; `mapper-js` ^0.3.0. Published to JSR as a library (`createServer`) and to GHCR as a runnable image, versioned and pinned by tag.

## 2. Authentication and authorization

Authentication is optional JWT bearer auth (`options.auth`: `secret` | `publicKey` | `jwksUri`, plus `algorithm` allowlist, `issuer`, `audience`, `clockSkew`); omitting `auth` disables it. `/health` endpoints are unauthenticated; everything else authenticates when auth is configured. The authenticated identity is available to mappings as `context.identity`.

Per-capability claims:

| Option                | Gates                        | Notes                               |
| --------------------- | ---------------------------- | ----------------------------------- |
| `map.claims`          | `POST /map` (both forms)     |                                     |
| `map.explicit.claims` | explicit form of `POST /map` | checked in addition to `map.claims` |
| `validate.claims`     | `POST /validate`             |                                     |

An operator can therefore run "registered mappings only" (explicit disabled), "explicit for these callers" (claims on the explicit form), or fully open (no auth, dev).

## 3. Endpoints

### 3.1 Summary

| Method | Path              | Auth | Purpose                                   |
| ------ | ----------------- | ---- | ----------------------------------------- |
| GET    | `/health`         | no   | process liveness (cheap)                  |
| GET    | `/health/mapping` | no   | mapping-path health (canary)              |
| POST   | `/map`            | yes* | evaluate a registered or explicit mapping |
| POST   | `/validate`       | yes* | validate a document or registered mapping |
| GET    | `/mappings`       | yes* | list registered mappings                  |
| GET    | `/extensions`     | yes* | list installed extension names            |

\* when auth is configured. The write namespace `POST`/`PUT`/`DELETE /mappings/*` is **reserved** (§8) and returns 404 in this version.

### 3.2 `POST /map`

One request key, **`mapping`, discriminated by type** — consistent with the engine's `Mapper.map()` interface.

**Registered form** — `mapping` is a string naming a registered mapping:

```json
{ "mapping": "echo", "input": { "message": "hello" } }
```

**Explicit form** — `mapping` is an object: a single mapping descriptor or a compound document:

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

Any other type for `mapping` (or a missing `mapping`) → 400.

Compound semantics follow the engine specification (mapper-js SPEC §5.3): the document's mappings are visible to each other and to `$ref` resolution, and the last mapping in document order is the entry. References resolve against the document first, then the installed registry, so a traveling family may call installed mappings but a document can never shadow one for anyone but its own request.

Explicit-form processing order:

1. Gate: explicit form must be enabled (`map.explicit`) — an object-valued `mapping` on a deployment without it returns **403** (the shape is legal; the capability is off) — and `map.explicit.claims` must be satisfied.
2. Validate the document (mapper-js `validate()`) against this instance's installed extension surface. Invalid → **422** with code `InvalidMappingDocument` and the full report (`valid`, `errors`, `warnings`, JSON Pointers, requirement ids).
3. Evaluate statelessly (§1.2 #3): the registered registry is never mutated; nothing about the request is observable to any other request.
4. Respond with the **same result envelope as the registered form**, status 200, `map.invalidStatus` honored identically.

### 3.3 `POST /validate`

Instance-level validation as a first-class capability. Two forms, same type discrimination as `/map`:

- `{ "mapping": { … } }` — validate a caller-supplied document against this instance (including referential reachability: do the referenced transformer names, plugin keys, and `$ref` targets exist _here_?).
- `{ "mapping": "resolve" }` — validate an already-registered mapping the same way (useful before first use, or after an image upgrade changes the extension surface).

Response is always **200 with the full report** — a validation report is data, not an error, even when `valid: false`. 4xx is reserved for the request itself being malformed (bad JSON, unknown registered id → 404, missing/mistyped `mapping` → 400).

### 3.4 `GET /mappings`

Returns the registered mappings — the read side of the instance's mapping set. Explicit submissions never appear here (a consequence of §3.2 statelessness).

### 3.5 `GET /extensions`

Discoverability for the installed extension surface — the names a mapping author (human or agent) can write against:

```json
{ "initializers": ["uuid", "date-time"], "transformers": ["toLowerCase"], "plugins": ["request"] }
```

Names only — never configuration, code, or values. Authenticated like every non-health endpoint.

### 3.6 `GET /health` and `GET /health/mapping`

`/health` is cheap, unauthenticated process liveness (`{ "status": "ok" }`).

`/health/mapping` exercises the real mapping path: it evaluates a canary mapping through the full engine and reports 200 only when evaluation completes within `health.timeout` (default 5000 ms); otherwise 503. The canary is `health.mapping` (a registered mapping id) when configured, else the bundled echo mapping. This exists because process liveness does not imply mapping-path liveness. The container `HEALTHCHECK` targets this endpoint.

## 4. Configuration

### 4.1 Programmatic

`createServer(mappings, extensions, options)`:

```js
{
  auth: { /* secret | publicKey | jwksUri, algorithm, issuer, audience, clockSkew */ },  // omit to disable auth
  cors: { /* origin, methods, headers */ },      // omit to disable CORS
  logging: { format: 'json' | 'pretty', level, slowThreshold },
  errorDetail: 'minimal' | 'full',               // 5xx detail policy (default 'minimal')
  maxBodyBytes: 1048576,                         // request-body cap (default 1 MiB → 413)
  requestIdPrefix: 'req_',
  map: {
    invalidStatus: 422,                          // optional: promote valid:false results to a client error
    claims: { /* … */ },                         // claims required for POST /map
    explicit: true | { claims: { /* … */ } }     // explicit form; absent/false = disabled
  },
  validate: { claims: { /* … */ } },             // POST /validate gating
  health: { mapping: '<id>', timeout: 5000 }     // canary configuration
}
```

### 4.2 Container / environment

| Variable       | Meaning                                                   | Default                  |
| -------------- | --------------------------------------------------------- | ------------------------ |
| `PORT`         | listen port                                               | `3333`                   |
| `MAPPINGS`     | mapping source: module path, document file, or directory  | bundled examples         |
| `EXTENSIONS`   | module path exporting extensions                          | bundled standard surface |
| `OPTIONS`      | the full `options` object as JSON                         | `{}`                     |
| `OPTIONS_FILE` | path to a file holding the `options` object (`.json`, `.yaml`, `.yml`) | unset       |

`PORT`/`MAPPINGS`/`EXTENSIONS` are bootstrap; `OPTIONS` (or `OPTIONS_FILE`) is the canonical channel for everything `createServer` accepts. There are no per-option environment variables: the programmatic options object is the only configuration vocabulary. Setting both `OPTIONS` and `OPTIONS_FILE`, or supplying a value that does not parse, fails startup loudly. Defaulted `MAPPINGS`/`EXTENSIONS` make the stock image standalone (§5) and the bundled dev task work out of the box.

### 4.3 Mapping sources

`MAPPINGS` accepts three forms, discriminated by what the path is:

1. **Module path** (`.js`/`.ts`) — the module's default export is the mappings descriptor.
2. **Document file** (`.json`, `.yaml`, `.yml`) — the file is one mapping document: a descriptor object or a compound document.
3. **Directory** — scanned recursively for `.json`/`.yaml`/`.yml` files, in lexicographic path order. Each file is one mapping document; every mapping they contain is registered by its `$id`. The same `$id` contributed by two files is a startup error (fail loud, no silent last-writer-wins). Non-document files in the tree are ignored with a startup warning.

Directory loading is built into the server — mounting a directory of mapping documents requires no index module or consumer-side assembly. `EXTENSIONS` remains a module path in all cases: extensions are code.

## 5. Image and deployment

1. **Published, versioned GHCR image, pinned by tag.**
2. **Standalone by default:** bare `docker run` serves the bundled example mappings and standard extension surface — a working mapping server in one command.
3. **Bring your own mappings without an image build:** bind-mount plus env — `-v ./mappings:/data/mappings -e MAPPINGS=/data/mappings` serves a directory of mapping documents directly (§4.3). Documented alongside a dev compose file.
4. **Custom images** layer deployment assets on the stock base: `FROM <stock image>` + `COPY` mappings/extensions + env. This path stays documented and supported; the standalone default does not preclude it.
5. **Container hygiene:** runs as `USER deno`; `HEALTHCHECK` targets `/health/mapping`; dependency layers cached before source copy.
6. The dev workflow and the container workflow are the same program: the bundled entrypoint with defaulted env.

## 6. Errors

Two-plane model restated in §1.2. Server-plane codes:

| Status | Code                     | When                                                                 |
| ------ | ------------------------ | -------------------------------------------------------------------- |
| 400    | `BadRequest`             | malformed JSON; `mapping` missing or neither string nor object       |
| 401    | `Unauthorized`           | missing/invalid token when auth configured                           |
| 403    | `Forbidden`              | claims not satisfied; explicit form disabled                         |
| 404    | `NotFound`               | unknown route (including the reserved `/mappings/*` write namespace); unknown registered mapping id |
| 405    | `MethodNotAllowed`       | wrong method on a known route                                        |
| 413    | `PayloadTooLarge`        | body over `maxBodyBytes`                                             |
| 422    | `InvalidMappingDocument` | explicit document fails validation; response carries the full report |
| 500    | `InternalError`          | unexpected failure; detail suppressed unless `errorDetail: 'full'`   |
| 503    | `Unavailable`            | `/health/mapping` canary failure/timeout                             |

## 7. Security considerations

- **Explicit documents change the trust posture.** A caller-supplied document drives the installed extensions — including any plugin that performs network requests — so the risk shape is SSRF-like. Mitigations in this specification: explicit form disabled unless enabled, independently claims-gated, document-validity gated, and strictly stateless so no submission outlives its request.
- **The mapping-path health canary runs unauthenticated.** `health.mapping` should name a cheap, side-effect-free mapping; a canary that performs requests or expensive work is invocable by any caller. `health.timeout` bounds the *response* (a 503 is returned on expiry), not the underlying evaluation, which is not cancelled — a request-performing canary is bounded instead by the request plugin's own timeout, and synchronous work cannot be interrupted at all. Keep the canary cheap.
- **Egress constraints** (allowlists for request-performing plugins) are acknowledged useful hardening and deliberately out of scope for this version.
- **Baseline protections:** algorithm-allowlisted JWT validation, request-body caps, 5xx detail suppression, and a redacting logger.

## 8. Non-goals and reserved ground

- **Managed mapping persistence** — a stock instance saving HTTP-delivered mappings to durable storage. The adopted long-term direction is a mapping-store boundary (load/list/save/watch, pluggable backends) climbing from static load (this version) through directory sources (§4.3) toward a version-controlled store; managed persistence itself is deferred, with ground reserved so it is not foreclosed:
  - Registered mappings are _loaded at startup_ (§1.1) — nothing in this specification ties the mapping set to the image.
  - The `POST`/`PUT`/`DELETE /mappings/*` namespace is reserved for future persistence operations; this version returns 404 there and nothing else may claim those routes.
  - `/map` never acquires persistence semantics: saving, when it arrives, is an explicit act on the reserved namespace, so ephemeral iteration composes with a later save of the same document.
- Multi-tenant registries; mapping-authoring UI.
- Dynamic route mounting (mappings mounted as live HTTP endpoints). Deferred, not precluded — the explicit-mapping call is its stateless subset.
- Soft-realtime, event-driven, parallel, or long-running operation modes. Future direction.

---

## Appendix A — Changes from 0.2.0

For readers upgrading from 0.2.0. The body of this specification stands alone; this appendix consolidates what changed.

**`POST /map` request contract.** 0.2.0 accepted `{ mapping, input }` and passed `mapping` to the engine without a type check. Because the engine's `Mapper.map()` accepts descriptors and compound documents, object-valued payloads were silently evaluated — and compound submissions were **registered into the shared instance**, mutating the registry across requests. 0.3.0 discriminates on type: strings are registered references; objects route through the explicit form — which must be enabled (`map.explicit`), is separately claims-gatable, is validated before evaluation, and is strictly stateless. Deployments that relied on object payloads must now enable `map.explicit`; the cross-request mutation path no longer exists. This change protects deployments that expose `/map` to callers who should not be able to alter the registry.

**New endpoints.** `POST /validate` (§3.3), `GET /extensions` (§3.5), and `GET /health/mapping` (§3.6). The `POST`/`PUT`/`DELETE /mappings/*` namespace is newly reserved (§8).

**New options.** `map.explicit`, `validate`, and `health` (§4.1). All 0.2.0 options (`auth`, `cors`, `logging`, `errorDetail`, `maxBodyBytes`, `requestIdPrefix`, `map.invalidStatus`, `map.claims`) carry forward unchanged.

**Configuration and startup.** `OPTIONS`/`OPTIONS_FILE` are formalized as the canonical runtime configuration channel (§4.2); previously, options-by-environment was improvised per deployment. `MAPPINGS` gains document-file and directory forms (§4.3); previously it accepted only a module path. `MAPPINGS`/`EXTENSIONS` now default to bundled content, making the stock image standalone.

**Container.** The image now runs as `USER deno`, its `HEALTHCHECK` targets `/health/mapping` instead of `/health`, and dependency layers are cached before source copy.

**Unchanged.** The result envelope, the two-plane error model, JWT mechanics, CORS, logging, request ids, and body limits.
