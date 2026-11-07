/**
 * THE DESKTOP MOUNT RUN — the window, rendered, with a ledger behind it.
 *
 *   npm run test:desktop-mount
 *
 * A third config, and the argument for it is `vitest.local.config.ts`'s
 * argument with one term changed. That run and the app's run disagree about
 * environment, setup and aliases; this run agrees with the app's about the
 * environment (jsdom — it renders React) and with the local run about
 * everything else, so it can be neither of them.
 *
 * ── THE ALIASES ARE THE WHOLE REASON THIS FILE EXISTS ───────────────────────
 *
 * `vitest.config.ts` maps all seven specifiers at the CLOUD halves, because it
 * is the web app's suite. A test of the desktop mount that ran there would
 * render the shared pages over `DataService` and a Clerk hook and would prove
 * nothing about a window — worse, it would pass, and it would go on passing on
 * the day the desktop build broke.
 *
 * Here `@data` is the open ledger file, `@session` is a preamble that already
 * happened, `@service` is six absences, and `@chrome` is the frame's furniture
 * with the cloud taken out of it. That is what `apps/desktop/vite.config.ts`
 * builds, and it is what this renders.
 *
 * ── AND THE SETUP, WHICH MUST NOT MOCK THE SUBJECT ──────────────────────────
 *
 * `src/test/setup.ts` replaces `contexts/AppContextSupabase` with a fixture
 * provider for every test in the app suite, which is right for a component test
 * and fatal here: the state layer booting for real is the thing being proved.
 * `src/test/setup.desktop.ts` keeps every browser shim and drops all three
 * cloud mocks.
 *
 * ── IT NEEDS NO RUST TOOLCHAIN, AND THAT IS A CHOICE WITH A COST ────────────
 *
 * The ledger is a fixture that answers the crate's own wire protocol, not a
 * `.db` file — so the real `LocalDataPort`, the real `deviceDocument`, the real
 * seams, the real router and the real pages are all exercised, and the CRATE is
 * not. That is deliberate: the crate has 468 Rust tests, a 127-case contract
 * suite and two differential lanes of its own, all of which need a binary and a
 * PostgreSQL cluster and run where those exist. What none of them can tell you
 * is whether the dashboard renders. This can, in two seconds, on any machine,
 * beside the renderer build in the same CI job.
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import desktopRenderer from './apps/desktop/vite.config';

export default defineConfig({
  plugins: [react()],
  // THE SHIPPED BUILD'S STAMP, borrowed rather than restated (7 Nov 2026): the
  // Settings case asserts the window says the version `tauri.conf.json` names,
  // and only the renderer's own `define` can make that a claim about the build.
  define: desktopRenderer.define,
  resolve: {
    alias: {
      '@data': path.resolve(process.cwd(), './src/services/local/deviceDataPort'),
      '@chrome': path.resolve(process.cwd(), './src/desktop/editions/chrome'),
      '@identity': path.resolve(process.cwd(), './src/desktop/editions/identity'),
      '@prefs-store': path.resolve(process.cwd(), './src/desktop/editions/preferencesStore'),
      '@rules-store': path.resolve(process.cwd(), './src/desktop/editions/rulesStore'),
      '@telemetry': path.resolve(process.cwd(), './src/desktop/editions/telemetry'),
      '@session': path.resolve(process.cwd(), './src/desktop/editions/session'),
      '@service': path.resolve(process.cwd(), './src/desktop/editions/service'),
      // False, so the window's Export page draws CSV and PDF and no Excel — the
      // one assertion in this run that is about what a person SEES rather than
      // about what the bundle weighs (owner, 1 Sep 2026).
      '@spreadsheet': path.resolve(process.cwd(), './src/desktop/editions/spreadsheet'),
      '@app-types': path.resolve(process.cwd(), './src/types'),
      '@': path.resolve(process.cwd(), './src')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.desktop.ts'],
    include: ['src/desktop/__tests__/desktopPages.test.tsx'],
    // Each case mounts a whole lazy page graph through Vite's transform. The
    // work is compilation, not the product, and a default that fits a component
    // test does not fit a window.
    testTimeout: 30_000,
    hookTimeout: 30_000
  },
  esbuild: {
    jsx: 'automatic'
  }
});
