/**
 * Bundled extension surface: the extensions the stock image serves.
 * Deployments replace this via the EXTENSIONS environment variable, or
 * extend it in a custom image; the shape is
 * `{ initializers, transformers, plugins }`.
 */
import mapperRequest from '@christiansmith/mapper-request'

export default {
  initializers: {},
  transformers: {},
  plugins: {
    request: mapperRequest.request
  }
}
