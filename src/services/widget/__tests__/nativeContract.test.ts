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
import { readFileSync } from 'node:fs';
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

  it("carries the app's build number, which App Store Connect requires to match", () => {
    const numbers = [...project.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(match => match[1]);
    expect(numbers).toHaveLength(4);
    expect(new Set(numbers).size).toBe(1);
  });
});
