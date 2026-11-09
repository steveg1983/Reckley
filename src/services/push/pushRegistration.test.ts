import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The plugin is faked the way Capacitor BUILDS it: a Proxy on which every
 * property read is a native call. The methods the file is allowed to use
 * answer; anything else — `then` above all — rejects with the message iOS
 * gives, and does NOT call the callbacks a promise would hand to a thenable.
 * That is the shape that hung every registration from 11 Sep to 9 Nov 2026
 * (see the header of pushRegistration.ts): a plugin returned bare from an
 * async function is asked for `then`, and the promise never settles.
 *
 * The native plugin is a device API, not a service, so faking it is within
 * the "only mock browser APIs" rule.
 */
type Receive = 'granted' | 'denied' | 'prompt';

const makeProxyPlugin = (receive: Receive) => {
  const calls: string[] = [];
  const known: Record<string, (...args: unknown[]) => unknown> = {
    checkPermissions: async () => ({ receive }),
    requestPermissions: async () => ({ receive }),
  };
  const plugin = new Proxy(
    {},
    {
      get(_target, property) {
        const name = String(property);
        calls.push(name);
        if (name in known) return known[name];
        return () => Promise.reject(new Error(`"PushNotifications.${name}()" is not implemented on ios`));
      },
    }
  );
  return { plugin, calls };
};

let fake = makeProxyPlugin('granted');

vi.mock('@capacitor/push-notifications', () => ({
  get PushNotifications() {
    return fake.plugin;
  },
}));

/** Fails in `ms` rather than letting a hung promise stall the suite. */
const within = <T>(ms: number, promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`still unsettled after ${ms}ms — the plugin was handed to a promise bare`)), ms)
    ),
  ]);

const originalCapacitor = window.Capacitor;

/**
 * Registration refuses, BEFORE it touches the plugin, when there is no
 * Supabase client to save a token with — Apple's prompt is never shown for
 * a token that could not be kept. CI runs this suite with no Supabase
 * variables, so the client is null there (locally `.env.local` supplies
 * them). These values give the module a client that is never called: every
 * path below ends before the upsert.
 */
const withACloudSession = (): void => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-for-a-client-this-suite-never-calls');
};

beforeEach(() => {
  window.Capacitor = { isNativePlatform: () => true };
  withACloudSession();
  vi.resetModules();
});

afterEach(() => {
  window.Capacitor = originalCapacitor;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('loading the push plugin', () => {
  it('settles — the plugin is never asked for `then`', async () => {
    fake = makeProxyPlugin('granted');
    const { notificationPermission } = await import('./pushRegistration');

    await expect(within(500, notificationPermission())).resolves.toBe('granted');
    expect(fake.calls).not.toContain('then');
  });

  it('reports a refusal without touching the network', async () => {
    fake = makeProxyPlugin('denied');
    const { registerThisPhone } = await import('./pushRegistration');

    await expect(within(500, registerThisPhone('00000000-0000-4000-8000-000000000001'))).resolves.toEqual({
      kind: 'denied',
    });
    expect(fake.calls).toContain('checkPermissions');
    expect(fake.calls).not.toContain('register');
    expect(fake.calls).not.toContain('then');
  });

  it('asks iOS when the answer is still open, and stops at a refusal there too', async () => {
    fake = makeProxyPlugin('prompt');
    const { registerThisPhone } = await import('./pushRegistration');

    // `requestPermissions` answers 'prompt' again in this fake, which the
    // code treats as anything-but-granted: a refusal, not a hang.
    await expect(within(500, registerThisPhone('00000000-0000-4000-8000-000000000001'))).resolves.toEqual({
      kind: 'denied',
    });
    expect(fake.calls).toContain('requestPermissions');
  });

  it('refuses before asking iOS when there is no cloud session to keep a token', async () => {
    fake = makeProxyPlugin('granted');
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    vi.resetModules();
    const { registerThisPhone } = await import('./pushRegistration');

    await expect(within(500, registerThisPhone('00000000-0000-4000-8000-000000000001'))).resolves.toEqual({
      kind: 'failed',
      message: 'No cloud session to register with',
    });
    expect(fake.calls).toEqual([]);
  });

  it('is not a phone when Capacitor is absent', async () => {
    window.Capacitor = undefined;
    const { notificationPermission, registerThisPhone } = await import('./pushRegistration');

    await expect(notificationPermission()).resolves.toBe('unknown');
    await expect(registerThisPhone('00000000-0000-4000-8000-000000000001')).resolves.toEqual({ kind: 'not-a-phone' });
  });
});
