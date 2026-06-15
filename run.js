import createServer from './src/index.js'

const port = Number(Deno.env.get('PORT') || 3333)
const mappingsPath   = Deno.env.get('MAPPINGS')
const extensionsPath = Deno.env.get('EXTENSIONS')
const optionsJson    = Deno.env.get('OPTIONS')

if (!mappingsPath || !extensionsPath) {
  console.error('Error: MAPPINGS and EXTENSIONS environment variables are required.')
  console.error('  -e MAPPINGS=/path/mappings/index.js')
  console.error('  -e EXTENSIONS=/path/extensions/index.js')
  Deno.exit(1)
}

let options = {}
if (optionsJson) {
  try {
    options = JSON.parse(optionsJson)
  } catch {
    console.error('Error: OPTIONS must be valid JSON.')
    Deno.exit(1)
  }
}

const { default: mappings }   = await import(mappingsPath)
const { default: extensions } = await import(extensionsPath)

const server = createServer(mappings, extensions, options)

server.listen({ port })
console.log(`mapper-http listening on http://localhost:${port}`)