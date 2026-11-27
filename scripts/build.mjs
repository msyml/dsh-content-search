import { readFile, writeFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/search.js', import.meta.url), 'utf8')
const client = await readFile(new URL('../lib/client.source.js', import.meta.url), 'utf8')
if (!source.includes('export async function searchWorkspace') || !source.includes('export { LIMIT as SEARCH_LIMITS };')) throw new Error('Unexpected search exports')
const search = source.replace('export async function searchWorkspace', 'async function searchWorkspace').replace('export { LIMIT as SEARCH_LIMITS };', '')
const output = `window.__ModuleLoader__.load({\n  id: 'dsh-content-search',\n  factory(require) {\n    const module = { exports: {} }; const exports = module.exports;\n${search}\n${client}\n    return module.exports;\n  }\n});\n`
await writeFile(new URL('../lib/client.js', import.meta.url), output)
console.log(`Built lib/client.js (${output.length} bytes)`)
