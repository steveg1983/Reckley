import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import SessionGuard from '../SessionGuard';

/**
 * NOBODY SIGNED IN, NO KEY ON THE PHONE.
 *
 * The widget's key outlives a session unless something takes it back, and a
 * session ends in four places, one of which (Clerk's avatar menu) calls no
 * code of ours. So the guard watches the state: Clerk loaded and nobody
 * signed in. What is held still here is that it empties a phone that holds a
 * key, leaves alone a phone that holds none (forgetting redraws every
 * widget), does nothing while somebody IS signed in or before Clerk has
 * answered, and does nothing at all outside a shell that carries the plugin.
 *
 * The plugin is faked as the kind of Proxy Capacitor hands out — any property
 * it is not asked for by name, `then` included, never answers — so a plugin
 * handed to a promise bare hangs the spec as it hung the phone (9 Nov 2026).
 */

const state = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false },
  held: true,
  calls: [] as string[],
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ ...state.auth, signOut: async () => undefined }),
}));

vi.mock('../../hooks/useSessionTimeout', () => ({ useSessionTimeout: () => undefined }));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => {
    const methods: Record<string, () => Promise<unknown>> = {
      status: async () => {
        state.calls.push('status');
        return { hasKey: state.held, keyId: state.held ? 'key-id-invented' : null };
      },
      clearKey: async () => {
        state.calls.push('clearKey');
        state.held = false;
      },
    };
    return new Proxy(
      {},
      {
        get: (_target, property) =>
          typeof property === 'string' && property in methods ? methods[property] : () => new Promise(() => undefined),
      }
    );
  },
}));

const shellWith = (plugins: string[]): void => {
  Object.defineProperty(window, 'Capacitor', {
    configurable: true,
    value: {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      isPluginAvailable: (name: string) => plugins.includes(name),
    },
  });
};

describe('SessionGuard and the widget key', () => {
  beforeEach(() => {
    state.auth = { isLoaded: true, isSignedIn: false };
    state.held = true;
    state.calls = [];
    shellWith(['ReckleyWidget']);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'Capacitor');
  });

  it('takes the key back from the phone when nobody is signed in', async () => {
    render(<SessionGuard />);
    await waitFor(() => expect(state.calls).toEqual(['status', 'clearKey']));
    expect(state.held).toBe(false);
  });

  it('asks first, and leaves a phone that holds no key alone', async () => {
    state.held = false;
    render(<SessionGuard />);
    await waitFor(() => expect(state.calls).toEqual(['status']));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.calls).toEqual(['status']);
  });

  it('does nothing while somebody is signed in', async () => {
    state.auth = { isLoaded: true, isSignedIn: true };
    render(<SessionGuard />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.calls).toEqual([]);
    expect(state.held).toBe(true);
  });

  it('does nothing before Clerk has answered — a phone with no network has not been signed out', async () => {
    state.auth = { isLoaded: false, isSignedIn: false };
    render(<SessionGuard />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.calls).toEqual([]);
  });

  it('takes it back at the moment a session ends', async () => {
    state.auth = { isLoaded: true, isSignedIn: true };
    const view = render(<SessionGuard />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.calls).toEqual([]);

    state.auth = { isLoaded: true, isSignedIn: false };
    view.rerender(<SessionGuard />);
    await waitFor(() => expect(state.calls).toEqual(['status', 'clearKey']));
  });

  it('does nothing in a shell older than the widget, or in a browser', async () => {
    shellWith([]);
    render(<SessionGuard />);
    await new Promise(resolve => setTimeout(resolve, 20));
    Reflect.deleteProperty(window, 'Capacitor');
    render(<SessionGuard />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.calls).toEqual([]);
  });
});
