# Changelog

Notable changes to `@christiansmith/mapper-http`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org). Pre-1.0, the public API may change between
minor versions.

## [0.3.2] — unreleased

Makes the redirect policy introduced by mapper-request 0.4.0 consumable
from the stock image as pure configuration, and classifies refused
redirects as client errors.

### Changed

- **A refused redirect is now `422 RedirectRefused`, previously
  `500 InternalError`.** A redirect the request plugin's policy declines
  to follow is a policy outcome meeting an ordinary web condition, not a
  server fault: the response carries the refusal message (which names the
  URL and the redirect target) and a structured `location` field. Clients
  keying on the status for this case must update. The mapping-path health
  canary is unaffected — a redirecting canary still reports `503`.
- `@christiansmith/mapper-request` `^0.4.0`: opt-in bounded redirect
  following (`redirect: 'follow'` — GET-only, bounded hops, same-origin
  plus https upgrade, every hop re-passed through `checkUrl`),
  construction-validated policy config, and the typed refusal error this
  release's classification is built on. See that package's changelog for
  the full surface and notes.

### Added

- A "Following redirects" section in the README: the extensions-module
  configuration a deployment uses to opt in, and the bounds that hold
  when it does.
- Tests pin the new contract end to end: refusal → 422 with `location`;
  an untyped plugin failure still → 500 with detail suppressed; a
  redirecting canary still → 503; and a follow-enabled surface resolves
  a trailing-slash 301 and maps.

## [0.3.1] — 2026-08-24

Dependency updates that deliver two fixes reported from the field, both
reachable through the stock image. No HTTP surface changes.

### Changed

- `@christiansmith/mapper-js` `^0.3.2`: `POST /validate` (and the
  explicit-mapping gate) now reports an unknown transformer name in
  string form as a validation error [KW-transform-1], completing the
  referential-reachability promise of SPEC §3.3. Previously such a
  document validated clean and the missing transformer was silently
  skipped at evaluation, so results could degrade with `valid: true`.
- `@christiansmith/mapper-request` `^0.3.0`: the stock `request` plugin
  accepts `url: { source | target | input | output }`, resolving the
  request URL from data at a named scope. This restores an expressible
  form for fetching a URL that arrives as data, removed by the 0.2.0
  pathname-encoding hardening, and extends it to four scopes. The
  descriptor-authored `origin`/`pathname` form is unchanged.

### Added

- Tests pin both behaviors end to end: `/validate` reports unknown
  transformer names against the instance surface, and the stock plugin
  fetches through `url: { source }`.

## [0.3.0] — 2026-08-24

Explicit mappings, instance-level validation, a standalone image, and
directory-loaded mapping sources. The specification (`SPEC.md`) is the
contract; its Appendix A carries the full migration detail from 0.2.0.

### Added

- `POST /map` accepts an explicit mapping document (a single descriptor or a
  compound document) as an alternative to a registered id, discriminated by the
  type of `mapping`. The explicit form is off unless enabled with
  `map.explicit`, is separately claims-gated (`map.explicit.claims`), validates
  the document before evaluation (invalid → 422 with the full report), and is
  strictly stateless — a submission never mutates the server or is observable to
  any other request.
- `POST /validate` validates a caller-supplied document or a registered mapping
  against this instance, including referential reachability. Always 200 with the
  full report `{ valid, errors, warnings }`.
- `GET /extensions` lists the installed initializer, transformer, and plugin
  names.
- `GET /health/mapping` evaluates a canary mapping through the full engine and
  reports 503 when it fails or outruns `health.timeout` (default 5000 ms).
- `MAPPINGS` accepts a module path, a document file (`.json`/`.yaml`/`.yml`), or
  a directory scanned recursively and registered by `$id` (duplicate `$id` is a
  startup error). `loadMappings` is exported.
- `OPTIONS` / `OPTIONS_FILE` as the canonical runtime configuration channel.
- New options: `map.explicit`, `validate.claims`, `health`.
- A published, standalone GHCR image: bundled example mappings and the stock
  extension surface (the `request` plugin), running as `USER deno`, with the
  `HEALTHCHECK` targeting `/health/mapping`. A bare `docker run` is a working
  mapping server.

### Changed

- `POST /map` discriminates on the type of `mapping`. An object payload routes
  through the explicit form (which must be enabled) instead of being silently
  registered into the shared instance; the registered form is string-only, and
  an unknown id is a 404. This closes the 0.2.0 cross-request registry-mutation
  path. See `SPEC.md` Appendix A.
- `@christiansmith/mapper-js` updated to `^0.3.1` and
  `@christiansmith/mapper-request` to `^0.2.0`; both resolve a single engine
  version.

### Security

- The stock `request` plugin is built with an empty header allowlist, so no
  caller-supplied request header is forwarded upstream; the plugin (0.2.0)
  refuses redirects and bounds each request with a timeout.
- The explicit-mapping validity gate rejects catastrophic regexes (via the
  engine's pattern-safety validation) before evaluation.
- Request bodies are bounded during the stream read, not after buffering, so an
  unbounded chunked body cannot be read into memory in full.
- A caller-supplied mapping is screened before it reaches the engine: a member
  `$id` of `__proto__`/`constructor`/`prototype`, or nesting past a maximum
  depth, is reported invalid rather than reaching the engine.

### Removed

- The Node package manifest (`package.json`). The server is Deno-built and
  distributed as an image and a Deno package.

## [0.2.0]

Production hardening: structured logging, request ids, typed two-plane errors,
request-body limits, and algorithm-allowlisted JWT auth. Published to JSR as
`@christiansmith/mapper-http`.

## [0.1.x]

Initial minimal Deno HTTP server for running Mapper mappings.
