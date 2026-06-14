/**
 * Structured logging. Two formats, one stream: line-delimited JSON for
 * production (log-aggregator friendly) or a compact human-readable line for
 * development, selected by config. Distributed tracing (traceId/spanId) is out
 * of scope for now.
 *
 * Sensitive data: JWTs are never logged — the `Authorization` header value, if
 * ever included in a record, is replaced with `Bearer [redacted]`. Request and
 * response bodies are logged only at `debug` level and only when
 * `bodiesEnabled` is true (never in production).
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** Replace any Authorization value with a redaction marker. */
function redact(record) {
  if (record.headers && record.headers.authorization) {
    record.headers = { ...record.headers, authorization: 'Bearer [redacted]' }
  }
  return record
}

/** Compact one-line render for the dev console. */
function pretty(record) {
  const time = String(record.timestamp).slice(11, 23)
  let line = `${time} ${record.level.toUpperCase().padEnd(5)} `
  line += record.method ? `${record.method} ${record.path} ${record.status} ${record.duration}ms` : record.message
  const extras = []
  if (record.requestId) {
    extras.push(`requestId=${record.requestId}`)
  }
  return extras.length ? `${line}\n  ${extras.join('  ')}` : line
}

/**
 * @param {{ format?: string, level?: string, slowThreshold?: number, bodiesEnabled?: boolean }} [config]
 */
export function createLogger(config = {}) {
  const format = config.format === 'pretty' ? 'pretty' : 'json'
  const min = config.level === 'silent' ? Infinity : LEVELS[config.level] || LEVELS.info

  /**
   * @param {keyof LEVELS} level
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  function emit(level, message, fields = {}) {
    if (LEVELS[level] < min) {
      return null
    }
    const record = redact({ timestamp: new Date().toISOString(), level, message, ...fields })
    const line = format === 'pretty' ? pretty(record) : JSON.stringify(record)
    if (level === 'error' || level === 'warn') {
      console.error(line)
    } else {
      console.log(line)
    }
    return record
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    bodiesEnabled: config.bodiesEnabled === true,
    slowThreshold: config.slowThreshold || 1000
  }
}
