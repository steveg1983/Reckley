import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileBottomNav from '../MobileBottomNav';

/**
 * The bottom bar is the whole navigation on a phone, so what is in it and
 * where each slot points is a product decision worth pinning down. Every
 * destination here must be a real route in App.tsx.
 */
function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <MobileBottomNav />
    </MemoryRouter>
  );
}

describe('MobileBottomNav', () => {
  it('offers the five phone destinations in order', () => {
    renderAt('/dashboard');

    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const labels = Array.from(nav.querySelectorAll('a')).map(a => a.textContent?.trim());

    // Find, where the global Transactions list used to be: on a phone you
    // either open the account in front of you or you are hunting for one row.
    expect(labels).toEqual(['Home', 'Accounts', 'Find', 'Reconcile', 'Categorise']);
  });

  it('steps its pill in from the iPhone Duo\'s status-pill column', () => {
    // 0px everywhere else: the variable only pays out where env() does.
    renderAt('/dashboard');
    const pill = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(pill.style.left).toBe('calc(0.5rem + var(--wt-side-inset-left, 0px))');
    expect(pill.style.right).toBe('calc(0.5rem + var(--wt-side-inset-right, 0px))');
    // Above phone width the pill stops growing and centres (the opened Duo
    // held upright, 9 Nov 2026) — a cap and auto margins inside that box.
    expect(pill.style.maxWidth).toBe('26rem');
    expect(pill.style.marginLeft).toBe('auto');
    expect(pill.style.marginRight).toBe('auto');
  });

  it('offers no slot for the retired global transactions list', () => {
    renderAt('/dashboard');

    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const hrefs = Array.from(nav.querySelectorAll('a')).map(a => a.getAttribute('href'));

    expect(hrefs).not.toContain('/transactions');
    expect(hrefs).toContain('/find');
  });

  it('sends Home to the dashboard, not the public welcome page', () => {
    renderAt('/dashboard');

    // "/" renders <Welcome/>, the marketing landing page. A signed-in user
    // tapping Home wants their figures.
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/dashboard');
  });

  it('points the two cleanup chores at the work, not at admin', () => {
    renderAt('/dashboard');
    expect(screen.getByRole('link', { name: 'Reconcile' })).toHaveAttribute('href', '/reconciliation');
    // The review ROUND — the Accounts page walking every account with rows
    // to review — not Manage → Categorisation, which is category admin. The
    // owner pressed this expecting the To Review flow (29 Sep 2026).
    expect(screen.getByRole('link', { name: 'Categorise' })).toHaveAttribute('href', '/accounts?focus=review');
  });

  it('marks only the current destination as the current page', () => {
    renderAt('/accounts?focus=review');
    expect(screen.getByRole('link', { name: 'Categorise' })).toHaveAttribute('aria-current', 'page');
    // The round is a mode of the Accounts page, and while its query is in
    // the address the Categorise slot outranks the plain Accounts slot —
    // one tab lights, not two.
    expect(screen.getByRole('link', { name: 'Accounts' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it("hands the current mark back to Accounts once the round's query is consumed", () => {
    renderAt('/accounts');
    expect(screen.getByRole('link', { name: 'Accounts' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Categorise' })).not.toHaveAttribute('aria-current');
  });

  it('does not treat the dashboard as current while reconciling', () => {
    renderAt('/reconciliation');

    expect(screen.getByRole('link', { name: 'Reconcile' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('gives every slot a 44px touch target', () => {
    /*
     * 44, not the 48 this asserted before, and the four pixels were bought
     * rather than given away.
     *
     * The bar became a floating pill and the quick-add moved INTO it, so six
     * things now share a row that used to hold five — and the pill is inset
     * from the window on top of that. Measured at 320px (the width the owner's
     * phone reports with Display Zoom on), a 48px floor does not fit beside
     * five whole labels: the slots want 265px, the button 44, and there are
     * 296 to go round. Something had to give, and the candidates were the
     * labels, the button, or these four pixels.
     *
     * The labels are load-bearing — "Reconcile" and "Categorise" are not
     * guessable from an icon, which is the whole reason this nav has captions
     * when Instagram's does not. So the floor drops to 44, which is not a
     * shrug: it is Apple's own figure, and it is the number this project's
     * own guidance has always specified. The 48 was Material's, stricter than
     * the rule it was enforcing.
     *
     * Verified at 320px after the change: no label clipped, every slot at
     * least 44x53, and the pill inside the viewport.
     */
    renderAt('/dashboard');

    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    for (const link of Array.from(nav.querySelectorAll('a'))) {
      expect(link.className).toContain('min-w-[44px]');
      expect(link.className).toContain('min-h-[48px]');
    }
  });

  it('keeps every label whole rather than dividing the row evenly', () => {
    /*
     * `flex-1` would be the obvious class and it is the bug: `flex: 1 1 0%`
     * starts every slot at zero and hands them identical widths, so "Find"
     * (21px of text) got exactly as much room as "Categorise" (57px) and three
     * of the five clipped once the quick-add joined the row. `flex-auto` is
     * `flex: 1 1 auto` — each slot starts at its own content width and only the
     * SPARE room is shared — and `shrink-0` stops the browser clawing it back
     * when the row is tight.
     *
     * jsdom does no layout, so this asserts the mechanism rather than the
     * pixels; the pixels were measured in a real engine at 320 and 390.
     */
    renderAt('/dashboard');

    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    for (const link of Array.from(nav.querySelectorAll('a'))) {
      expect(link.className).toContain('flex-auto');
      expect(link.className).toContain('shrink-0');
      expect(link.className).not.toMatch(/\bflex-1\b/);
    }
  });
});

/**
 * The floating "+" is the phone's ONLY way to add without first navigating —
 * the desktop dashboard's four quick-action tiles have gone, and on a phone the
 * sidebar that names those destinations is behind a tap. So this button, and
 * the two things it offers, are load-bearing on mobile and are pinned here.
 */
describe('the phone quick-add', () => {
  it('offers a floating + that opens Add Transaction and Add Account', () => {
    renderAt('/dashboard');

    const fab = screen.getByRole('button', { name: 'Quick actions' });
    /*
     * It is no longer `md:hidden fixed` in its own right: it is a slot INSIDE
     * the nav, which is itself the thing that is phone-only and pinned. Two
     * floating round objects stacked in one corner is what the pill shape
     * stops looking calm about — and folding it in gave 3.5rem of reserved
     * screen back to every mobile page.
     *
     * So the invariant moves up a level: the button must LIVE in the phone nav,
     * which is a stronger statement than owning the two utilities itself, and
     * it does not silently pass if someone drops the button back onto the page.
     */
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(nav.className).toContain('md:hidden');
    expect(nav.className).toContain('fixed');
    expect(nav.contains(fab)).toBe(true);

    fireEvent.click(fab);

    // Both point at pages that exist. The two parameters are deliberately
    // different words: `add` on /accounts already means "add an ACCOUNT" (the
    // Accounts page reads it), while the add-transaction modal is Layout's and
    // is opened by an app-wide parameter on whatever page it lands on.
    expect(screen.getByRole('link', { name: 'Add Transaction' }))
      .toHaveAttribute('href', '/accounts?action=add-transaction');
    expect(screen.getByRole('link', { name: 'Add Account' }))
      .toHaveAttribute('href', '/accounts?action=add');
  });

  it('keeps the menu shut until it is asked for', () => {
    renderAt('/dashboard');

    expect(screen.queryByRole('link', { name: 'Add Transaction' })).not.toBeInTheDocument();
  });
});
