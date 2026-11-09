import React, { useEffect, useState } from 'react';

/**
 * WHAT THE DEVICE ACTUALLY REPORTS — readable from inside the installed app.
 *
 * Exists because the iOS home-screen wrapper has now been caught lying twice
 * about the same fact: since 26.1 it insets the webview behind its own bars
 * while still reporting full env() safe-area values, and on the owner's
 * iPhone (iOS 27, 1 Sep 2026) it does not match `display-mode: standalone`
 * either — so a fix keyed on that media query shipped, deployed, and did
 * nothing, and nobody could tell WHY from a screenshot. The values that
 * distinguish the possible causes are exactly the ones only the device can
 * report, and the installed app cannot take the ?viewport-debug=1 URL the
 * existing overlay is gated on — a wrapper launches its start URL and offers
 * no address bar. So the facts live here, on a Settings page the wrapper CAN
 * reach, always rendered and costing a few quiet lines.
 *
 * Nothing here is money; nothing here is a date. Every read is wrapped so a
 * browser that refuses one probe still reports the rest.
 */

const readFacts = (): string[] => {
  const facts: string[] = [];
  const line = (label: string, read: () => string): void => {
    try {
      facts.push(`${label}: ${read()}`);
    } catch {
      facts.push(`${label}: (unreadable)`);
    }
  };
  const doc = document.documentElement;
  line('display-mode standalone', () =>
    String(window.matchMedia?.('(display-mode: standalone)').matches === true)
  );
  line('navigator.standalone', () =>
    String((window.navigator as Navigator & { standalone?: boolean }).standalone)
  );
  line('installed-app class', () => String(doc.classList.contains('wt-installed-app')));
  line('env safe-area top / right / bottom / left', () => {
    // A probe, because env() cannot be read off a variable that a rule may
    // have overridden — the probe reports what the DEVICE pays, the vars
    // below report what the app decided to do with it. All four edges: the
    // iPhone Duo pays its status pill as a RIGHT inset when closed (84px,
    // 9 Nov 2026), the first phone to pay a side in portrait.
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;height:0;width:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
      'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const answer = `${style.paddingTop} / ${style.paddingRight} / ${style.paddingBottom} / ${style.paddingLeft}`;
    probe.remove();
    return answer;
  });
  const docStyle = getComputedStyle(doc);
  line('--wt-status-bar-inset', () => docStyle.getPropertyValue('--wt-status-bar-inset').trim() || '(unset)');
  line('--wt-home-indicator-inset', () => docStyle.getPropertyValue('--wt-home-indicator-inset').trim() || '(unset)');
  line('--wt-side-inset-left / right', () =>
    `${docStyle.getPropertyValue('--wt-side-inset-left').trim() || '(unset)'} / ${docStyle.getPropertyValue('--wt-side-inset-right').trim() || '(unset)'}`
  );
  line('viewport / screen', () =>
    `${window.innerWidth}×${window.innerHeight} / ${window.screen.width}×${window.screen.height}`
  );
  line('window reaches screen top', () => String(window.innerHeight >= window.screen.height));
  // The detector's own evidence trail — what it saw, attempt by attempt.
  for (const entry of window.__wtInstalledAppTrace ?? []) {
    facts.push(`· ${entry}`);
  }
  return facts;
};

export default function DisplayDiagnostics(): React.JSX.Element {
  const [facts, setFacts] = useState<string[]>([]);
  // Effect, not render: the probe touches the DOM, and SSR/first paint have
  // no body to append it to.
  useEffect(() => setFacts(readFacts()), []);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 p-5">
      <h2 className="text-body font-semibold text-gray-900 dark:text-white">Display diagnostics</h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        What this device reports about its screen and app mode — useful in a
        support conversation, and changing nothing by being read.
      </p>
      <div className="mt-3 rounded-lg bg-gray-50 dark:bg-gray-900 px-3 py-2 font-mono text-[12px] leading-5 text-gray-700 dark:text-gray-300">
        {facts.map(fact => (
          <div key={fact}>{fact}</div>
        ))}
      </div>
    </div>
  );
}
