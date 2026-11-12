/**
 * THE PAGE AND THE SHELL AGREE ABOUT THE WIDGET, IN WRITING.
 *
 * The page finds the widget plugin by NAME (`widgetBridge.ts`) and the shell
 * registers it by name (`ReckleyWidgetPlugin.swift`). Nothing compiles the two
 * together: the shell loads the page from the network, Swift is not in CI,
 * and a rename on either side builds green on both and hides the Settings
 * card on every installed phone. So the names are read out of the Swift here.
 *
 * The same goes for the keychain group the app writes the key into and the
 * widget extension reads it from — spelled three times (two entitlements and
 * the store), and a mismatch is a widget that says "turn me on" for ever.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIDGET_PLUGIN_NAME } from '../widgetBridge';
import { WIDGET_KEY_PREFIX } from '../../../../api/_lib/widget-key';

const IOS = join(process.cwd(), 'apps/mobile/ios/App');
const read = (path: string): string => readFileSync(join(IOS, path), 'utf8');

const plugin = read('App/ReckleyWidgetPlugin.swift');
const store = read('Shared/WidgetKeyStore.swift');

describe('the widget plugin the shell carries', () => {
  it('answers to the name the page asks for', () => {
    expect(plugin).toContain(`public let jsName = "${WIDGET_PLUGIN_NAME}"`);
  });

  it('exposes exactly the four methods the page calls', () => {
    const exposed = [...plugin.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map(match => match[1]);
    expect(exposed.sort()).toEqual(['clearKey', 'reload', 'setKey', 'status']);
    for (const method of exposed) {
      expect(plugin).toContain(`@objc func ${method}(_ call: CAPPluginCall)`);
    }
  });

  it('never answers a call with the key itself', () => {
    const answers = [...plugin.matchAll(/call\.resolve\(\[([\s\S]*?)\]\)/g)].map(match => match[1]);
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) {
      expect(answer).not.toMatch(/\.key\b|"key"/);
    }
  });

  it('takes only the keys the server mints', () => {
    expect(plugin).toContain(`keyPrefix = "${WIDGET_KEY_PREFIX}"`);
  });

  it('is registered by the view controller the storyboard names', () => {
    expect(read('App/ReckleyBridgeViewController.swift')).toContain('registerPluginInstance(ReckleyWidgetPlugin())');
    expect(read('App/Base.lproj/Main.storyboard')).toContain(
      'customClass="ReckleyBridgeViewController" customModule="App" customModuleProvider="target"'
    );
  });
});

describe('the keychain group the key is shared through', () => {
  const group = /static let accessGroup = "([A-Z0-9]+)\.([\w.]+)"/.exec(store);

  it('is spelled in the store', () => {
    expect(group).not.toBeNull();
  });

  it.each([
    ['the app', 'App/App.entitlements'],
    ['the widget extension', 'ReckleyWidgets/ReckleyWidgets.entitlements'],
  ])('is one %s is entitled to', (_who, path) => {
    expect(read(path)).toContain(`<string>$(AppIdentifierPrefix)${group?.[2]}</string>`);
  });

  it('carries the team the project signs with', () => {
    expect(read('App.xcodeproj/project.pbxproj')).toContain(`DEVELOPMENT_TEAM = ${group?.[1]};`);
  });

  it("leaves the app's own group first, so what it already keeps stays where it was", () => {
    const groups = [...read('App/App.entitlements').matchAll(/\$\(AppIdentifierPrefix\)([\w.]+)/g)].map(match => match[1]);
    expect(groups[0]).toBe('com.wealthtracker.mobile');
  });
});

describe('the widget extension', () => {
  const project = read('App.xcodeproj/project.pbxproj');

  it('is embedded in the app, with the store compiled into both', () => {
    expect(project).toContain('ReckleyWidgets.appex in Embed Foundation Extensions');
    expect(project.match(/WidgetKeyStore\.swift in Sources \*\/,/g)).toHaveLength(2);
  });

  // The project file is edited by hand: a Swift file dropped into the folder
  // and never listed compiles nowhere, and the widget it holds is simply
  // absent from the gallery with no error anywhere.
  it('compiles every Swift file in its folder', () => {
    const files = readdirSync(join(IOS, 'ReckleyWidgets')).filter(name => name.endsWith('.swift'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(project).toContain(`${file} in Sources */,`);
    }
  });

  it('offers every widget it defines', () => {
    const bundle = read('ReckleyWidgets/ReckleyWidgetsBundle.swift');
    const defined = readdirSync(join(IOS, 'ReckleyWidgets'))
      .filter(name => name.endsWith('.swift'))
      .flatMap(name => [...read(`ReckleyWidgets/${name}`).matchAll(/^struct (\w+): Widget \{/gm)].map(match => match[1]));
    expect(defined.sort()).toEqual(['KeyBudgetsWidget', 'OneBudgetWidget']);
    for (const widget of defined) {
      expect(bundle).toContain(`${widget}()`);
    }
  });

  // The owner, 12 Nov 2026: "Make the home screen bars follow the choice too".
  // The bar cannot be drawn without the choice, and both widgets hand it over.
  it('every home-screen bar follows "used or left"', () => {
    const key = read('ReckleyWidgets/KeyBudgetsWidget.swift');
    const one = read('ReckleyWidgets/OneBudgetWidget.swift');
    const bar = key.slice(key.indexOf('struct BudgetBar'));
    expect(bar).toMatch(/let asLeft: Bool\n/);
    expect(bar).toContain('asLeft ? 100 - used : used');
    expect(bar).toContain('space.size.width * fill / 100');
    expect(key).toContain('document.percentAs == "left"');
    expect(key).toContain('BudgetBar(budget: budget, asLeft: asLeft)');
    expect(one).toContain('BudgetBar(budget: shown.budget, asLeft: entry.percentAsLeft)');
    expect(`${key}${one}`).not.toMatch(/BudgetBar\(budget: [^,)]*\)/);
  });

  // The owner's lock screen showed an amount on build 9 (11 Nov 2026): the
  // ring was percentage-only and the other two lock-screen shapes drew the
  // server's words, which are money by default. The server's words appear
  // ONCE in this file now — in the home-screen shape, which is behind the lock.
  it('no lock-screen shape draws or speaks the server\u2019s words, which can be an amount', () => {
    const one = read('ReckleyWidgets/OneBudgetWidget.swift');
    const lockScreen = one.slice(one.indexOf('// \u2500\u2500 Lock screen'));
    expect(lockScreen.length).toBeGreaterThan(200);
    expect(lockScreen).not.toMatch(/budget\.(status|spent|allowance|perDay)/);
    expect(lockScreen.match(/lockScreenWords\(for: shown\.budget, asLeft: entry\.percentAsLeft\)/g)).toHaveLength(3);
    // Used or left, by the person's choice — a percentage either way.
    expect(lockScreen).toContain('% left');
    expect(lockScreen).toContain('% used');
    // The ring AND the bar take their fill from the one place that reads the
    // choice: "95% left" over a bar of what is used read as nearly gone.
    expect(lockScreen.match(/fillFigures\(for: shown\.budget\)/g)).toHaveLength(2);
    expect(lockScreen).not.toMatch(/ProgressView\(value: [^)]*budget\.percent/);
    const homeScreen = one.slice(0, one.indexOf('// \u2500\u2500 Lock screen'));
    expect(homeScreen.match(/shown\.budget\.status/g)).toHaveLength(1);
  });

  it("carries the app's build number, which App Store Connect requires to match", () => {
    const numbers = [...project.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(match => match[1]);
    expect(numbers).toHaveLength(4);
    expect(new Set(numbers).size).toBe(1);
  });
});
