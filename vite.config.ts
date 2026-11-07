import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import compression from 'vite-plugin-compression2'
import path from 'path'
import fs from 'fs'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

// WHICH BUILD THIS IS, for the About card on /settings (7 Nov 2026). The web
// has no version number, because it deploys on every merge, so it is the
// commit Vercel built, short form. Unset outside Vercel, and then the card
// says nothing rather than a number nobody chose. See src/lib/appRelease.ts.
const deployedCommit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7)

// https://vite.dev/config/
export default defineConfig({
  define: {
    __RECKLEY_RELEASE__: JSON.stringify(deployedCommit ? { kind: 'build', value: deployedCommit } : null),
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss,
        autoprefixer,
      ],
    },
  },
  plugins: [
    react(),
    // DEV-ONLY: serve the gitignored MS Money local seed (real financial
    // data) from OUTSIDE public/ — public/ is copied verbatim into dist, so
    // keeping the seed there would bundle it into a build. apply:'serve'
    // means this route exists only on the dev server; builds never see it.
    {
      name: 'mny-local-seed-dev-only',
      apply: 'serve' as const,
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] !== '/mny-local-seed.json') { next(); return; }
          const seedPath = path.resolve(process.cwd(), '.mny-local/mny-local-seed.json');
          if (!fs.existsSync(seedPath)) {
            res.statusCode = 404;
            res.end('mny-local-seed.json not generated — run scripts/mnyLocalImport.mts');
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          fs.createReadStream(seedPath).pipe(res);
        });
      },
    },
    // Add gzip compression for better mobile performance
    compression({
      algorithms: ['gzip'],
      threshold: 1024, // Compress files larger than 1kb for mobile
      deleteOriginalAssets: false,
    }),
    // Add brotli compression for modern browsers
    compression({
      algorithms: ['brotliCompress'],
      threshold: 1024,
      deleteOriginalAssets: false,
    })
  ],
  resolve: {
    alias: {
      // THE EDITION SEAM. Shared UI imports `@data`; each build says which
      // engine that is. This one is the cloud's — `services/port/index.ts`,
      // whose one line is `DataService`. The desktop build points the same
      // specifier at `services/local/deviceDataPort.ts` instead, which is how a
      // window gets a file and a browser gets an account without a single
      // component knowing which it is. See docs/edition-gating.md.
      //
      // FIRST, and that is load-bearing: Vite matches aliases in order by
      // prefix, so the '@' below would otherwise claim '@data' and resolve it to
      // `src/…data`, which does not exist. The same goes for the four seams
      // below it.
      '@data': path.resolve(__dirname, './src/services/port'),
      // THE MOUNT SLICE'S FOUR. The shared Layout used to reach Clerk, a bank
      // feed, a Supabase client and Sentry; these are what it reaches instead,
      // and each build says which half it gets. See docs/edition-gating.md.
      '@chrome': path.resolve(__dirname, './src/editions/cloud/chrome'),
      '@identity': path.resolve(__dirname, './src/editions/cloud/identity'),
      '@prefs-store': path.resolve(__dirname, './src/editions/cloud/preferencesStore'),
      '@rules-store': path.resolve(__dirname, './src/editions/cloud/rulesStore'),
      '@telemetry': path.resolve(__dirname, './src/editions/cloud/telemetry'),
      // THE MOUNT SLICE'S SECOND HALF. `@session` is whose ledger this is and
      // what must happen before it can be read; `@service` is the three
      // settings panels that are about the hosted SERVICE rather than about the
      // ledger. See docs/edition-gating.md.
      '@session': path.resolve(__dirname, './src/editions/cloud/session'),
      '@service': path.resolve(__dirname, './src/editions/cloud/service'),
      // WHETHER THIS EDITION WRITES .xlsx (1 Sep 2026). A browser does, and this
      // half is where the 488 KiB spreadsheet writer is reachable from — the
      // desktop's half reaches no writer at all, which is what keeps it out of a
      // binary that embeds every chunk it builds. See docs/edition-gating.md.
      '@spreadsheet': path.resolve(__dirname, './src/editions/cloud/spreadsheet'),
      '@': path.resolve(__dirname, './src'),
      // Fix for recharts es-toolkit import issue
      // This ensures recharts gets the correct export format
      'es-toolkit/compat/get': 'lodash-es/get'
    }
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    open: false,
    // Enables the JS Self-Profiling API in dev, so performance work can
    // attribute main-thread time to real functions instead of guessing.
    headers: {
      'Document-Policy': 'js-profiling'
    },
    proxy: {
      '/api': {
        target: 'https://wealthtracker-web.vercel.app',
        changeOrigin: true,
        secure: true
      }
    }
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
    open: false
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 500, // Lowered from 1000 to enforce stricter bundle size limits
    rollupOptions: {
      output: {
        // Let Rollup handle chunking automatically to avoid circular chunk dependencies
        // Manual chunking previously caused TDZ crashes ("Cannot access before initialization")
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      },
      // Aggressive tree-shaking optimizations
      treeshake: {
        preset: 'recommended',
        moduleSideEffects: 'no-external', // Internal modules (services) have side effects; only externals are safe
        propertyReadSideEffects: false,
        manualPureFunctions: ['console.log', 'console.warn', 'console.debug', 'console.info']
      }
    },
    // Use esbuild (Vite default) - Terser causes TDZ crashes with circular deps
    minify: 'esbuild',
    target: 'es2022', // Use more modern JavaScript for smaller bundles
    // Report compressed size
    reportCompressedSize: true,
    // CSS code splitting
    cssCodeSplit: true,
    // Asset inlining threshold (inline small assets)
    assetsInlineLimit: 4096
  },
  // Optimize dependencies
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom', 'react-is'],
    // Exclude heavy libraries that are lazy-loaded
    exclude: ['xlsx', 'jspdf', 'html2canvas', 'tesseract.js'],
    esbuildOptions: {
      // Force CommonJS modules to be treated as ES modules
      mainFields: ['module', 'main']
    }
  }
})