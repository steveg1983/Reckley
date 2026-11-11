import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WidgetSettings from '../WidgetSettings';
import { preferences, PORTABLE_PREFERENCE_KEYS } from '../../../services/preferencesService';
import { widgetSettingsFrom } from '../../../../api/_lib/widget-budgets';

/**
 * HOME-SCREEN WIDGETS — the card that exists only where a widget can.
 *
 * What is held still here: the card is ABSENT in a browser and in an
 * installed build older than the widget (the page is newer than the app
 * whenever the app has not been updated); switching on hands the phone a key
 * and keeps none; a key that cannot be handed over is revoked at once;
 * switching off empties the phone BEFORE it tells the server; and the two
 * choices land in the very keys the server shapes the widget's document from.
 *
 * Clerk is answered signed-in (the suite-wide stub answers signed-out, which
 * would hide the card for the wrong reason). The native plugin and `fetch`
 * are stubbed because both are bridges to things a test runner does not
 * have — iOS, and a deployed route. The plugin is faked as the kind of Proxy
 * Capacitor really hands out: any property it is not asked for by name,
 * `then` included, is a native call that never answers. A plugin handed to a
 * promise bare therefore hangs the spec, as it hung the phone (9 Nov 2026).
 */

const native = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; options: unknown }>,
  held: null as { key: string; keyId: string; origin: string } | null,
  refuseSetKey: false,
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isSignedIn: true, userId: 'user_invented', getToken: async () => 'session-token-invented' }),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => {
    const methods: Record<string, (options?: unknown) => Promise<unknown>> = {
      status: async () => ({ hasKey: native.held !== null, keyId: native.held?.keyId ?? null }),
      setKey: async (options) => {
        native.calls.push({ method: 'setKey', options });
        if (native.refuseSetKey) throw new Error('the keychain refused');
        native.held = options as { key: string; keyId: string; origin: string };
      },
      clearKey: async () => {
        native.calls.push({ method: 'clearKey', options: undefined });
        native.held = null;
      },
      reload: async () => {
        native.calls.push({ method: 'reload', options: undefined });
      },
    };
    return new Proxy(
      {},
      {
        get: (_target, property) =>
          typeof property === 'string' && property in methods
            ? methods[property]
            : () => new Promise(() => undefined),
      }
    );
  },
}));

interface Posted {
  authorization: string | null;
  body: Record<string, unknown>;
}
const posted: Posted[] = [];
let minted = 0;
/** What the server says of the phones with widgets on; asking is counted apart from `posted`, which is what CHANGED something. */
let phonesOnTheServer: Array<{ id: string; label: string; createdAt: string; lastUsedAt: string | null }> = [];
let listsAsked = 0;

const answerTheKeyRoute = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/widget/key');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.action === 'list') {
        listsAsked += 1;
        return new Response(JSON.stringify({ keys: phonesOnTheServer }), { status: 200 });
      }
      posted.push({ authorization: new Headers(init?.headers).get('Authorization'), body });
      if (body.action === 'mint') {
        minted += 1;
        return new Response(JSON.stringify({ id: `key-id-${minted}`, key: `rkw_invented_${minted}` }), { status: 201 });
      }
      return new Response(JSON.stringify({ revoked: 1 }), { status: 200 });
    })
  );
};

const shell = (withWidgetPlugin: boolean): void => {
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    isPluginAvailable: (name) => withWidgetPlugin && name === 'ReckleyWidget',
  };
};

const theSwitch = (): HTMLElement => screen.getByRole('checkbox', { name: /Budget widgets on this phone/ });

describe('WidgetSettings', () => {
  beforeEach(() => {
    preferences.detach();
    localStorage.clear();
    native.calls.length = 0;
    native.held = null;
    native.refuseSetKey = false;
    posted.length = 0;
    minted = 0;
    phonesOnTheServer = [];
    listsAsked = 0;
    answerTheKeyRoute();
  });

  afterEach(() => {
    delete window.Capacitor;
    vi.unstubAllGlobals();
  });

  it('draws nothing in a browser — there is no home screen to put a widget on', () => {
    const { container } = render(<WidgetSettings />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing in an installed build older than the widget', () => {
    shell(false);
    const { container } = render(<WidgetSettings />);
    expect(container).toBeEmptyDOMElement();
  });

  it('in a build that has widgets: off, amounts, shown when locked — the defaults', async () => {
    shell(true);
    render(<WidgetSettings />);

    expect(screen.getByRole('heading', { name: 'Home-screen widgets' })).toBeInTheDocument();
    expect(theSwitch()).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Amounts/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Percentages only/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Hide figures while the phone is locked/ })).not.toBeChecked();
    // Nothing is CHANGED on the server by looking at the card.
    expect(posted).toEqual([]);
  });

  it('shows the switch on when the phone already holds a key', async () => {
    shell(true);
    native.held = { key: 'rkw_already', keyId: 'key-id-earlier', origin: 'https://invented.example' };
    render(<WidgetSettings />);
    await waitFor(() => expect(theSwitch()).toBeChecked());
  });

  it('switching on mints a key as the signed-in person and hands it to the phone, with where to fetch from', async () => {
    shell(true);
    render(<WidgetSettings />);

    await userEvent.click(theSwitch());
    await waitFor(() => expect(theSwitch()).toBeChecked());

    expect(posted).toEqual([
      { authorization: 'Bearer session-token-invented', body: { action: 'mint', label: 'iPhone' } },
    ]);
    expect(native.calls).toEqual([
      { method: 'setKey', options: { key: 'rkw_invented_1', keyId: 'key-id-1', origin: window.location.origin } },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent(/Widgets are on/);
  });

  it('keeps no copy of the key: not on the page, not in storage', async () => {
    shell(true);
    const { container } = render(<WidgetSettings />);
    await userEvent.click(theSwitch());
    await waitFor(() => expect(theSwitch()).toBeChecked());

    expect(container.innerHTML).not.toContain('rkw_');
    const stored = Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`).join('\n');
    expect(stored).not.toContain('rkw_');
  });

  it('a key the phone will not take is revoked at once, and the switch stays off', async () => {
    shell(true);
    native.refuseSetKey = true;
    render(<WidgetSettings />);

    await userEvent.click(theSwitch());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/could not be switched on: the keychain refused/));

    expect(posted.map((call) => call.body)).toEqual([
      { action: 'mint', label: 'iPhone' },
      { action: 'revoke', id: 'key-id-1' },
    ]);
    expect(theSwitch()).not.toBeChecked();
  });

  it('switching off empties the phone first, then tells the server which key is dead', async () => {
    shell(true);
    native.held = { key: 'rkw_already', keyId: 'key-id-earlier', origin: 'https://invented.example' };
    render(<WidgetSettings />);
    await waitFor(() => expect(theSwitch()).toBeChecked());

    await userEvent.click(theSwitch());
    await waitFor(() => expect(posted).toHaveLength(1));

    expect(native.calls).toEqual([{ method: 'clearKey', options: undefined }]);
    expect(native.held).toBeNull();
    expect(posted[0].body).toEqual({ action: 'revoke', id: 'key-id-earlier' });
    expect(theSwitch()).not.toBeChecked();
  });

  it('is off on the phone even when the server cannot be told', async () => {
    shell(true);
    native.held = { key: 'rkw_already', keyId: 'key-id-earlier', origin: 'https://invented.example' };
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    render(<WidgetSettings />);
    await waitFor(() => expect(theSwitch()).toBeChecked());

    await userEvent.click(theSwitch());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Widgets are off on this phone.'));
    expect(native.held).toBeNull();
  });

  it('a choice is saved where the server reads it, then the widgets are asked to fetch again', async () => {
    shell(true);
    render(<WidgetSettings />);

    await userEvent.click(screen.getByRole('radio', { name: /Percentages only/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Hide figures while the phone is locked/ }));
    await waitFor(() => expect(native.calls.filter((call) => call.method === 'reload')).toHaveLength(2));

    // The server's own reader, over what the card wrote.
    const written = {
      widgetDisplay: preferences.getItem('widgetDisplay') ?? '',
      widgetHideWhenLocked: preferences.getItem('widgetHideWhenLocked') ?? '',
    };
    expect(widgetSettingsFrom(written)).toMatchObject({ display: 'percent', hideWhenLocked: true });

    await userEvent.click(screen.getByRole('radio', { name: /Amounts/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Hide figures while the phone is locked/ }));
    await waitFor(() => expect(native.calls.filter((call) => call.method === 'reload')).toHaveLength(4));
    expect(
      widgetSettingsFrom({
        widgetDisplay: preferences.getItem('widgetDisplay') ?? '',
        widgetHideWhenLocked: preferences.getItem('widgetHideWhenLocked') ?? '',
      })
    ).toMatchObject({ display: 'amounts', hideWhenLocked: false });
  });

  it('both choices travel with the account', () => {
    expect(PORTABLE_PREFERENCE_KEYS).toContain('widgetDisplay');
    expect(PORTABLE_PREFERENCE_KEYS).toContain('widgetHideWhenLocked');
  });

  /**
   * A LOST PHONE (owner, 11 Nov 2026). The switch is about this phone; a lost
   * phone is not this phone. The card says which phones have widgets on and
   * turns every one off — from a browser too, which is where a person without
   * their phone will be.
   */
  describe('turning widgets off for a phone you no longer have', () => {
    const lost = { id: 'key-lost', label: 'iPhone', createdAt: '2026-11-01T09:00:00.000Z', lastUsedAt: '2026-11-10T14:00:00.000Z' };
    const spare = { id: 'key-spare', label: 'iPhone', createdAt: '2026-11-05T09:00:00.000Z', lastUsedAt: null };

    it('in a browser with no phone switched on: still nothing', async () => {
      const { container } = render(<WidgetSettings />);
      await waitFor(() => expect(listsAsked).toBe(1));
      expect(container).toBeEmptyDOMElement();
    });

    it('in a browser: names the phones, and one press kills every key', async () => {
      phonesOnTheServer = [lost, spare];
      render(<WidgetSettings />);

      expect(await screen.findByText('Budget widgets are on for 2 phones')).toBeInTheDocument();
      const section = screen.getByTestId('widget-phones');
      expect(section).toHaveTextContent(/switched on 1 Nov 2026|switched on 01\/11\/2026/);
      expect(section).toHaveTextContent('has not fetched yet');
      // No switch and no choices: there is no phone here to switch.
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Turn off on every phone' }));

      await waitFor(() => expect(posted).toHaveLength(1));
      // No id: every key the person has.
      expect(posted[0]).toEqual({ authorization: 'Bearer session-token-invented', body: { action: 'revoke' } });
      expect(await screen.findByRole('status')).toHaveTextContent(/off on every phone/);
      // Says what it cannot do: a phone that is offline keeps what it drew.
      expect(screen.getByRole('status')).toHaveTextContent(/offline keeps showing the last figures/);
      expect(screen.queryByTestId('widget-phones')).not.toBeInTheDocument();
      // Nothing native was touched: there is no plugin in a browser.
      expect(native.calls).toEqual([]);
    });

    it('on a phone: lists only the OTHER phones, and turning all off empties this one first', async () => {
      shell(true);
      native.held = { key: 'rkw_invented_here', keyId: 'key-here', origin: 'https://www.reckley.co.uk' };
      phonesOnTheServer = [{ ...lost, id: 'key-here' }, lost];
      render(<WidgetSettings />);

      await waitFor(() => expect(theSwitch()).toBeChecked());
      expect(await screen.findByText('Budget widgets are also on for another phone')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Turn off on every phone' }));

      await waitFor(() => expect(posted).toHaveLength(1));
      expect(native.calls.map(call => call.method)).toEqual(['clearKey']);
      expect(posted[0].body).toEqual({ action: 'revoke' });
      expect(theSwitch()).not.toBeChecked();
    });

    it('on a phone that is the only one: no list, no second control', async () => {
      shell(true);
      native.held = { key: 'rkw_invented_here', keyId: 'key-here', origin: 'https://www.reckley.co.uk' };
      phonesOnTheServer = [{ ...lost, id: 'key-here' }];
      render(<WidgetSettings />);

      await waitFor(() => expect(theSwitch()).toBeChecked());
      await waitFor(() => expect(listsAsked).toBeGreaterThan(0));
      expect(screen.queryByTestId('widget-phones')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Turn off on every phone' })).not.toBeInTheDocument();
    });

    it('a server that cannot say draws no list, and the switch still works', async () => {
      shell(true);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
      render(<WidgetSettings />);
      expect(await screen.findByRole('heading', { name: 'Home-screen widgets' })).toBeInTheDocument();
      expect(screen.queryByTestId('widget-phones')).not.toBeInTheDocument();
    });
  });
});
