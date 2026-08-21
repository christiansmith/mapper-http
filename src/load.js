/**
 * Mapping sources. A deployment's MAPPINGS value names one of three things,
 * discriminated by what the path is:
 *
 *   - a module path (`.js`/`.ts`): the module's default export is the
 *     mappings descriptor
 *   - a document file (`.json`/`.yaml`/`.yml`): the file is one mapping
 *     document
 *   - a directory: scanned recursively for document files in lexicographic
 *     path order
 *
 * Vocabulary: a **mapping document** is either a **compound document** (it
 * has a `mappings` object) or a **single mapping descriptor**. A document
 * *contributes* mappings — a compound contributes its members, a descriptor
 * contributes itself — and every contributed mapping registers by its `$id`.
 *
 * Assembly fails loud: a mapping without an `$id` is a startup error, and so
 * is the same `$id` contributed twice (the error names both sources — no
 * silent last-writer-wins). Non-document files in a directory are ignored
 * with a warning. Extensions remain a module path in all cases: extensions
 * are code.
 */
import { parse } from '@std/yaml'

const DOCUMENT_EXTENSIONS = ['.json', '.yaml', '.yml']
const MODULE_EXTENSIONS = ['.js', '.ts']

/**
 * isPlainObject - a non-null, non-array object.
 * @param {unknown} value
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * isCompound - a compound document carries its members under `mappings`.
 * @param {object} document
 */
function isCompound(document) {
  return isPlainObject(document.mappings)
}

/**
 * membersOf - the mappings a document contributes: a compound contributes
 * its members; a single descriptor contributes itself.
 * @param {object} document
 */
function membersOf(document) {
  return isCompound(document) ? Object.values(document.mappings) : [document]
}

/**
 * extension - the file extension of a path, lowercased, empty when none.
 * @param {string} path
 */
function extension(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * importDefault - dynamically import a module path (relative to the working
 * directory, or absolute) and return its default export.
 * @param {string} path
 */
export async function importDefault(path) {
  const url = new URL(path, `file://${Deno.cwd()}/`)
  const module = await import(url.href)
  return module.default
}

/**
 * readDocumentFile - read and parse one document file by its extension:
 * JSON for `.json`, YAML for `.yaml`/`.yml`.
 * @param {string} path
 */
export async function readDocumentFile(path) {
  const text = await Deno.readTextFile(path)
  return extension(path) === '.json' ? JSON.parse(text) : parse(text)
}

/**
 * assemble - build the registry descriptor from documents and their source
 * paths, applying the contribution rule and the fail-loud checks in one
 * place.
 * @param {Array<{ document: object, path: string }>} documents
 */
function assemble(documents) {
  const registry = {}
  const sources = {}

  for (const { document, path } of documents) {
    for (const mapping of membersOf(document)) {
      const id = isPlainObject(mapping) ? mapping.$id : undefined
      if (!id) {
        throw new Error(`mapping without $id in ${path}`)
      }
      if (Object.hasOwn(registry, id)) {
        throw new Error(`duplicate mapping $id "${id}" in ${path} (already registered from ${sources[id]})`)
      }
      registry[id] = mapping
      sources[id] = path
    }
  }

  return { mappings: registry }
}

/**
 * scanDocuments - walk a directory recursively and return the document file
 * paths in lexicographic path order, reporting non-document files.
 * @param {string} dir
 * @param {(message: string) => void} warn
 */
async function scanDocuments(dir, warn) {
  const documents = []

  async function walk(current) {
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`
      if (entry.isDirectory) {
        await walk(path)
      } else if (DOCUMENT_EXTENSIONS.includes(extension(path))) {
        documents.push(path)
      } else {
        warn(`ignoring non-document file ${path}`)
      }
    }
  }

  await walk(dir)
  return documents.sort()
}

/**
 * loadDirectory - parse every document file under a directory and assemble
 * their contributions.
 * @param {string} dir
 * @param {(message: string) => void} warn
 */
async function loadDirectory(dir, warn) {
  const documents = []

  for (const path of await scanDocuments(dir, warn)) {
    let document
    try {
      document = await readDocumentFile(path)
    } catch {
      warn(`ignoring unparseable document file ${path}`)
      continue
    }

    if (!isPlainObject(document)) {
      warn(`ignoring non-document file ${path}`)
      continue
    }

    documents.push({ document, path })
  }

  return assemble(documents)
}

/**
 * loadMappings - resolve a MAPPINGS value to a mappings descriptor ready for
 * `createServer` (see the module header for the discrimination and the
 * fail-loud rules). A compound document file passes through whole, so its
 * own `$id` and `description` reach the engine instance; a single-descriptor
 * file and a directory assemble through the shared contribution rule.
 * @param {string} path
 * @param {{ warn?: (message: string) => void }} [options]
 */
export async function loadMappings(path, options) {
  const warn = (options && options.warn) || ((message) => console.warn(`mapper-http: ${message}`))
  const stat = await Deno.stat(path)

  if (stat.isDirectory) {
    return loadDirectory(path.replace(/\/+$/, ''), warn)
  }

  const ext = extension(path)

  if (MODULE_EXTENSIONS.includes(ext)) {
    return await importDefault(path)
  }

  if (DOCUMENT_EXTENSIONS.includes(ext)) {
    const document = await readDocumentFile(path)
    if (!isPlainObject(document)) {
      throw new Error(`not a mapping document: ${path}`)
    }
    return isCompound(document) ? document : assemble([{ document, path }])
  }

  throw new Error(
    `MAPPINGS must be a module path (.js/.ts), a document file (.json/.yaml/.yml), or a directory: ${path}`
  )
}
