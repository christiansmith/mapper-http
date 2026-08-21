/**
 * Bundled entrypoint. The dev workflow and the container workflow are the
 * same program: this file with defaulted environment.
 *
 *   PORT          listen port                                   3333
 *   MAPPINGS      module path, document file, or directory      bundled examples
 *   EXTENSIONS    module path exporting extensions              bundled surface
 *   OPTIONS       the full options object as JSON               {}
 *   OPTIONS_FILE  file holding the options object (.json/.yaml/.yml)
 *
 * PORT/MAPPINGS/EXTENSIONS are bootstrap; OPTIONS (or OPTIONS_FILE) is the
 * canonical channel for everything createServer accepts — there are no
 * per-option environment variables. Setting both OPTIONS and OPTIONS_FILE,
 * or supplying a value that does not parse, fails startup.
 */
import createServer from './src/index.js'
import { importDefault, loadMappings, readDocumentFile } from './src/load.js'

/**
 * fail - report a startup error and exit non-zero.
 * @param {string} message
 */
function fail(message) {
  console.error(`mapper-http: ${message}`)
  Deno.exit(1)
}

const here = new URL('.', import.meta.url)
const defaultMappings = new URL('mappings', here).pathname
const defaultExtensions = new URL('extensions/index.js', here).pathname

const port = Number(Deno.env.get('PORT') || 3333)
const mappingsPath = Deno.env.get('MAPPINGS') || defaultMappings
const extensionsPath = Deno.env.get('EXTENSIONS') || defaultExtensions
const optionsJson = Deno.env.get('OPTIONS')
const optionsFile = Deno.env.get('OPTIONS_FILE')

if (optionsJson && optionsFile) {
  fail('set OPTIONS or OPTIONS_FILE, not both')
}

let options = {}
if (optionsJson) {
  try {
    options = JSON.parse(optionsJson)
  } catch {
    fail('OPTIONS is not valid JSON')
  }
} else if (optionsFile) {
  try {
    options = await readDocumentFile(optionsFile)
  } catch {
    fail(`OPTIONS_FILE could not be read or parsed: ${optionsFile}`)
  }
}

let mappings
try {
  mappings = await loadMappings(mappingsPath)
} catch (err) {
  fail(`MAPPINGS failed to load: ${err instanceof Error ? err.message : err}`)
}

let extensions
try {
  extensions = await importDefault(extensionsPath)
} catch (err) {
  fail(`EXTENSIONS failed to load: ${err instanceof Error ? err.message : err}`)
}

const server = createServer(mappings, extensions, options)

server.listen({ port })
console.log(`mapper-http listening on http://localhost:${port}`)
