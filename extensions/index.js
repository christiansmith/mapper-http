/**
 * Bundled extension surface: the extensions the stock image serves.
 * Deployments replace this via the EXTENSIONS environment variable, or
 * extend it in a custom image; the shape is
 * `{ initializers, transformers, plugins }`.
 *
 * The request plugin is built with a strict header policy (`allowHeaders: []`):
 * caller-authored explicit mapping documents can reach this plugin, so no
 * request header a caller supplies is forwarded upstream. A deployment that
 * needs header forwarding can build its own instance via `createRequest`.
 */
import mapperRequest from '@christiansmith/mapper-request'

export default {
  initializers: {},
  transformers: {},
  plugins: {
    request: mapperRequest.createRequest({ allowHeaders: [] })
  }
}
