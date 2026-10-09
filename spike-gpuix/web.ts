/**
 * Bundle app.tsx for the browser and serve it.
 *
 * The Wasm renderer uses shared memory, so every response needs the two
 * cross-origin isolation headers. A production host must send the same ones.
 *
 * `@gpuix/native` resolves to its `browser` entry during a browser build. That
 * entry imports the Wasm file, so Bun copies it next to the bundle. Nothing
 * here has to know where the package lives.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(ROOT, 'web-dist')

const bundle = await Bun.build({
  entrypoints: [path.join(ROOT, 'app.tsx')],
  outdir: OUT,
  target: 'browser',
  format: 'esm',
  naming: 'app.js',
  throw: false,
})
if (!bundle.success) {
  for (const message of bundle.logs) console.error(message)
  // Inside the GPUIX repository `packages/native/wasm/` is gitignored, so the
  // browser renderer has to be built once. A copied app never hits this: the
  // published `@gpuix/native` ships the Wasm files.
  console.error(
    '\nweb: if the Wasm renderer is missing and this is the GPUIX repository,' +
      ' run `bun run build:web` in packages/native'
  )
  process.exit(1)
}

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

function contentType(pathname: string): string {
  if (pathname.endsWith('.wasm')) return 'application/wasm'
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) return 'text/javascript'
  return 'text/html'
}

const server = Bun.serve({
  port: Number(process.env.PORT || 4173),
  fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/favicon.ico') {
      return new Response(null, { status: 204, headers: ISOLATION })
    }
    const file =
      pathname === '/' ? path.join(ROOT, 'index.html') : path.join(OUT, pathname.slice(1))
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      return new Response('Not found', { status: 404 })
    }
    return new Response(Bun.file(file), {
      headers: { ...ISOLATION, 'Content-Type': contentType(pathname) },
    })
  },
})

console.log(`web: http://localhost:${server.port}`)
