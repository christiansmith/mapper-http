/**
 * Typed API errors. Each carries the machine-readable `code` and HTTP `status`
 * the server renders it with, so the request boundary can produce a consistent
 * error envelope (see respond.js). These are *server* errors — distinct from a
 * mapping's own validation state, which the server returns as data.
 */

export class ApiError extends Error {
  /**
   * @param {string} code machine-readable PascalCase code
   * @param {string} message human-readable message
   * @param {number} status HTTP status
   * @param {Record<string, unknown>} [extra] extra fields (e.g. `errors`)
   */
  constructor(code, message, status, extra) {
    super(message)
    this.name = code
    this.code = code
    this.status = status
    if (extra) {
      Object.assign(this, extra)
    }
  }
}

export class BadRequestError extends ApiError {
  /** @param {string} message */
  constructor(message) {
    super('BadRequest', message, 400)
  }
}

export class ValidationError extends ApiError {
  /**
   * Carries a mapping's validation `errors` when a deployment opts to promote
   * `valid:false` into a client error (see the `map.invalidStatus` option).
   * @param {string} message
   * @param {unknown[]} errors
   * @param {number} [status] defaults to 422
   */
  constructor(message, errors, status) {
    super('ValidationError', message, status || 422, { errors })
  }
}

export class InvalidMappingDocumentError extends ApiError {
  /**
   * Carries the full mapper-js validation report when an explicit mapping
   * document fails the validity gate: the document is never evaluated, and
   * the report — not a mapping result — is what the caller gets back.
   * @param {{ valid: boolean, errors: unknown[], warnings: unknown[] }} report
   */
  constructor(report) {
    super('InvalidMappingDocument', 'The submitted mapping document is invalid', 422, { report })
  }
}

export class UnauthorizedError extends ApiError {
  /** @param {string} message */
  constructor(message) {
    super('Unauthorized', message, 401)
  }
}

export class ForbiddenError extends ApiError {
  /** @param {string} message */
  constructor(message) {
    super('Forbidden', message, 403)
  }
}

export class NotFoundError extends ApiError {
  /** @param {string} message */
  constructor(message) {
    super('NotFound', message, 404)
  }
}

export class MethodNotAllowedError extends ApiError {
  /** @param {string} message */
  constructor(message) {
    super('MethodNotAllowed', message, 405)
  }
}

export class PayloadTooLargeError extends ApiError {
  /** @param {string} message */
  constructor(message) {
    super('PayloadTooLarge', message, 413)
  }
}

export class UnavailableError extends ApiError {
  /** @param {string} message */
  constructor(message) {
    super('Unavailable', message, 503)
  }
}
