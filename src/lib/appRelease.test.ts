/**
 * THE ABOUT CARD SAYS WHAT THE BUILD IS, OR NOTHING.
 *
 * It said "Version 1.0" in both editions until 7 Nov 2026 — literal text, true
 * of neither: the desktop window was 0.1.6, and the web app has no version
 * number. These pin the three answers and the two stamps that produce them.
 * The window itself is asserted in desktopPages.test.tsx, under the renderer
 * build's own `define`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { currentRelease, releaseLine } from './appRelease';

const REPO = path.resolve(__dirname, '..', '..');

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A config's `__RECKLEY_RELEASE__`, loaded the way Vite loads it for a build.
 *
 * In a child process rather than by import: this suite runs under jsdom, whose
 * TextEncoder fails the invariant esbuild checks on load, and Vite bundles every
 * config with esbuild. A plain Node process is also the truer test — it is what
 * `vite build` itself does with the file.
 */
const stampOf = (configFile: string, env: Record<string, string>): unknown => {
  const script = `
    const { loadConfigFromFile } = await import('vite');
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, ${JSON.stringify(configFile)}, undefined, 'silent');
    process.stdout.write(JSON.stringify(loaded?.config.define?.__RECKLEY_RELEASE__ ?? 'NO DEFINE'));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000
  });
  if (run.status !== 0) throw new Error(`loading ${configFile} failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
};

describe('the line under the product name', () => {
  it('names the desktop by its version', () => {
    expect(releaseLine({ kind: 'version', value: '0.1.6' })).toBe('Version 0.1.6');
  });

  it('names the web by the commit it was built from', () => {
    expect(releaseLine({ kind: 'build', value: '6e00bc6' })).toBe('Build 6e00bc6');
  });

  it('says nothing when the build was not stamped — never a number nobody chose', () => {
    expect(releaseLine(null)).toBeNull();
    expect(releaseLine({ kind: 'version', value: '' })).toBeNull();
  });

  it('reads the stamp when one is there, and answers null rather than throwing when not', () => {
    // No `define` in this run, so the global does not exist at all: a bare
    // read would be a ReferenceError on every page that renders the card.
    expect(currentRelease()).toBeNull();
    expect(releaseLine()).toBeNull();

    vi.stubGlobal('__RECKLEY_RELEASE__', { kind: 'version', value: '9.9.9' });
    expect(releaseLine()).toBe('Version 9.9.9');
  });
});

describe('what each build stamps', () => {
  it('the desktop renderer: the version tauri.conf.json names', () => {
    const { version } = JSON.parse(
      readFileSync(path.join(REPO, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')
    ) as { version: string };

    expect(stampOf('apps/desktop/vite.config.ts', {})).toBe(
      JSON.stringify({ kind: 'version', value: version })
    );
  });

  it('the web: the deployed commit, short form, when Vercel names one', () => {
    expect(
      stampOf('vite.config.ts', { VERCEL_GIT_COMMIT_SHA: '6e00bc66b590011a3c795020c3a11b117b85f599' })
    ).toBe(JSON.stringify({ kind: 'build', value: '6e00bc6' }));
  });

  it('the web outside Vercel: no stamp, so no line', () => {
    expect(stampOf('vite.config.ts', { VERCEL_GIT_COMMIT_SHA: '' })).toBe('null');
  });
});
