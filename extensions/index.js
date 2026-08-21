/**
 * Bundled extension surface. Deployments replace this via the EXTENSIONS
 * environment variable, or extend it in a custom image; the shape is
 * `{ initializers, transformers, plugins }`.
 */
export default {
  initializers: {},
  transformers: {},
  plugins: {}
}
