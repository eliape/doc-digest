import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// PDF.js fetches these at runtime by directory URL: wasm image decoders
// (JPEG 2000 and JBIG2, common in scanned books), fonts PDFs reference but
// don't embed, CMaps for CJK text, and ICC colour profiles.
const PDFJS_ASSET_DIRS = ['wasm', 'standard_fonts', 'cmaps', 'iccs']
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))

/** Serve (dev) and copy (build) PDF.js's runtime assets under /pdfjs/<dir>/. */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const [dir, file, ...rest] = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
        if (!PDFJS_ASSET_DIRS.includes(dir) || !file || rest.length || file.startsWith('.')) return next()
        const path = join(pdfjsRoot, dir, file)
        if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return next()
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
        createReadStream(path).pipe(res)
      })
    },
    generateBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        for (const file of readdirSync(join(pdfjsRoot, dir))) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${file}`, source: readFileSync(join(pdfjsRoot, dir, file)) })
        }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), svelteTesting(), pdfjsAssets()],
  server: {
    // Forward API calls to the local Python backend (see ../backend).
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
