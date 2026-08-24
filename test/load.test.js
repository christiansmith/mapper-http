/**
 * Dependencies
 */
import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { loadMappings } from '../src/load.js'
import createServer from '../src/index.js'

const FIXTURES = new URL('./fixtures', import.meta.url).pathname

Deno.test('a directory registers every mapping it contains, recursively', async () => {
  const warnings = []
  const result = await loadMappings(`${FIXTURES}/mappings`, { warn: (message) => warnings.push(message) })

  assertEquals(typeof result.mappings.echo, 'object')
  assertEquals(typeof result.mappings.greet, 'object')
  assertEquals(Object.keys(result.mappings).length, 2)
})

Deno.test('non-document files in a directory warn and are ignored', async () => {
  const warnings = []
  await loadMappings(`${FIXTURES}/mappings`, { warn: (message) => warnings.push(message) })

  assertEquals(warnings.length, 1)
  assertStringIncludes(warnings[0], 'notes.txt')
})

Deno.test('the same $id from two files is a startup error naming both', async () => {
  const err = await assertRejects(() => loadMappings(`${FIXTURES}/duplicates`, { warn: () => {} }))
  assertStringIncludes(err.message, 'twin')
  assertStringIncludes(err.message, 'one.json')
  assertStringIncludes(err.message, 'two.json')
})

Deno.test('a single-descriptor document file registers by its $id', async () => {
  const result = await loadMappings(`${FIXTURES}/single.yaml`)
  assertEquals(typeof result.mappings.double, 'object')
})

Deno.test('a compound document file is the descriptor itself', async () => {
  const result = await loadMappings(`${FIXTURES}/compound.json`)
  assertEquals(result.$id, 'family')
  assertEquals(typeof result.mappings.inner, 'object')
})

Deno.test('a module path resolves to its default export', async () => {
  const result = await loadMappings(`${FIXTURES}/module.js`)
  assertEquals(result.$id, 'from-module')
  assertEquals(typeof result.mappings.modular, 'object')
})

Deno.test('an unrecognized extension is an error', async () => {
  const err = await assertRejects(() => loadMappings(`${FIXTURES}/mappings/notes.txt`))
  assertStringIncludes(err.message, 'MAPPINGS')
})

Deno.test('a directory-loaded registry serves through createServer', async () => {
  const mappings = await loadMappings(`${FIXTURES}/mappings`, { warn: () => {} })
  const server = createServer(mappings, {}, { logging: { level: 'silent' } })
  const res = await server.fetch(
    new Request('http://x/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapping: 'greet', input: { message: 'hello' } })
    })
  )
  assertEquals(res.status, 200)
  assertEquals((await res.json()).text, 'hello')
})
