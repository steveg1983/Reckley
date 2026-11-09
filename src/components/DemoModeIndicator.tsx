import React, { useLayoutEffect, useRef } from 'react';
import { isDemoMode } from '../utils/demoData';
import { sidePadding } from './layout/chromeOffsets';

/**
 * How far everything pinned to the top of the window has to move down to clear
 * the demo banner.
 *
 * WHY a CSS variable rather than a shared constant: the banner is the only
 * thing that knows how tall it is. Its height comes from its own text at
 * whatever the viewport width happens to be, so a hard-coded 40px would be a
 * guess that goes wrong the first time the copy wraps. Publishing the measured
 * height means the headers offset by exactly the right amount and, crucially,
 * the variable is simply ABSENT outside demo mode — every consumer falls back
 * to 0px and the normal layout is untouched.
 */
const BANNER_HEIGHT_VAR = '--wt-demo-banner-height';

export const DemoModeIndicator: React.FC = () => {
  const bannerRef = useRef<HTMLDivElement>(null);
  const active = isDemoMode();

  useLayoutEffect((): (() => void) | undefined => {
    const banner = bannerRef.current;
    if (!active || banner === null) return undefined;

    const root = document.documentElement;
    const publishHeight = (): void => {
      root.style.setProperty(BANNER_HEIGHT_VAR, `${banner.offsetHeight}px`);
    };

    // Measured in a layout effect, before paint, so the headers are already in
    // the right place on the first frame rather than jumping down after it.
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(banner);

    return (): void => {
      observer.disconnect();
      root.style.removeProperty(BANNER_HEIGHT_VAR);
    };
  }, [active]);

  if (!active) {
    return null;
  }

  return (
    <div
      ref={bannerRef}
      // z-30, BELOW the app header's z-40. The banner used to sit at z-50 over
      // a fixed z-40 header, which put an opaque yellow bar across the whole
      // top of the app: in demo mode the notification bell and the global
      // search box were not merely hidden, they swallowed every click aimed at
      // them. Now the header is offset clear of the banner instead of fighting
      // it for the same strip of screen, so the two no longer overlap at all
      // and the stacking order is just a belt-and-braces tiebreak.
      //
      // Navy with a 3px gold mark, not a gold bar: this is ENVIRONMENT STATUS,
      // and a full-bleed gold strip above every screen was the loudest amber
      // in the product — including on Reconciliation, where amber is a
      // reserved word meaning "your next move". The gold survives as a sliver
      // of identity; the banner itself joins the app's own chrome.
      // `padding-top` from the status-bar inset rather than a `top` offset, so
      // the bar's own colour fills the strip behind the clock and the battery
      // instead of leaving a white gap above it. In a browser tab the inset is
      // 0px and this is exactly the bar that shipped; on a home screen it is
      // what stops the banner rendering underneath the status bar — see
      // TOP_CHROME_OFFSET in Layout, and note the height this component
      // publishes is measured AFTER this padding, so everything below still
      // clears it.
      style={{ paddingTop: 'var(--wt-status-bar-inset, 0px)', ...sidePadding('1rem') }}
      className="fixed top-0 left-0 right-0 z-30 bg-secondary text-white border-l-[3px] border-accent text-center py-2"
    >
      <div className="flex items-center justify-center gap-2">
        <span className="text-xl">🎭</span>
        <span className="font-semibold">Demo Mode Active</span>
        <span className="text-sm">- Using sample data for UI/UX testing</span>
        <a
          href="/"
          className="ml-4 text-sm underline hover:no-underline"
          onClick={() => {
            // Clear demo mode and reload
            const url = new URL(window.location.href);
            url.searchParams.delete('demo');
            window.location.href = url.toString();
          }}
        >
          Exit Demo
        </a>
      </div>
    </div>
  );
};

export default DemoModeIndicator;
