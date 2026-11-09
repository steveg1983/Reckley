import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Welcome from '../Welcome';

/**
 * A SIGNED-OUT PAGE CARRIES ITS OWN HEADER, AND NOTHING ELSE'S.
 *
 * The sign-in shell used to render inside the app's Layout, which put nine
 * controls — Dashboard, Accounts, Plan, Reports, Manage, Settings, search, a
 * bell, help — in front of a visitor who could use none of them (design
 * handover 29 Aug, §5.1: "Signed-out gets wordmark plus Sign in and nothing
 * else"). The route moved outside Layout; what this file holds in place is
 * that the page brings its own minimal header and never grows app chrome of
 * its own.
 */

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isSignedIn: false }),
  SignInButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignUpButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const renderWelcome = (): void => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Welcome />
    </MemoryRouter>
  );
};

describe('the signed-out front door', () => {
  it('offers the wordmark and the two account actions', () => {
    renderWelcome();
    expect(screen.getAllByText('Reckley').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Sign in' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Create an account' })).toBeInTheDocument();
  });

  it('renders none of the app chrome a visitor cannot use', () => {
    renderWelcome();
    // The nine controls the old shell showed. None may return.
    for (const label of ['Dashboard', 'Reports', 'Manage', 'Settings']) {
      expect(screen.queryByRole('link', { name: new RegExp(label, 'i') })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /notifications/i })).not.toBeInTheDocument();
  });

  it('is a full page — it paints its own ground rather than borrowing chrome', () => {
    renderWelcome();
    // The wrapper carries min-h-screen: outside Layout there is nothing
    // behind this page, so it must cover the viewport itself.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.closest('.min-h-screen')).not.toBeNull();
  });

  it('pays the side insets itself, being outside the Layout that pays them for every other page', () => {
    renderWelcome();
    // The iPhone Duo bills its camera pill as a safe-area inset down the
    // whole right edge when closed (84px, 9 Nov 2026); the header's Sign in
    // was drawn under it because this page is mounted outside Layout.
    const ground = screen.getByRole('heading', { level: 1 }).closest<HTMLElement>('.min-h-screen');
    if (!ground) throw new Error('the page lost its ground');
    expect(ground.style.paddingLeft).toBe('var(--wt-side-inset-left, 0px)');
    expect(ground.style.paddingRight).toBe('var(--wt-side-inset-right, 0px)');
  });
});

/**
 * GATE 5.2, HELD IN PLACE. The handover's other shipping condition: every
 * security claim on this page must be literally true today. Three sentences
 * were qualified under that audit (30 Aug 2026) — Stripe's, the backup
 * card's, and the trial terms — and these tests are what stops the original,
 * stronger, false versions drifting back in a copy edit.
 */
describe('the claims carry their qualifications', () => {
  it('names the five vendors it asks the reader to check', () => {
    renderWelcome();
    for (const vendor of ['Clerk', 'TrueLayer', 'Supabase', 'Vercel', 'Stripe']) {
      expect(screen.getByText(vendor)).toBeInTheDocument();
    }
  });

  it('says what Stripe reports back, not "never held here"', () => {
    renderWelcome();
    // The DB keeps brand, last four and expiry from Stripe for the billing
    // page, so the absolute version was an overclaim.
    expect(screen.getByText(/what stays here is only what Stripe reports back/)).toBeInTheDocument();
    expect(screen.queryByText(/never held here/)).not.toBeInTheDocument();
  });

  it('says encrypting an export is chosen, because the default is a plain file', () => {
    renderWelcome();
    expect(screen.getByText(/if you choose, lock it with a passphrase only you hold/)).toBeInTheDocument();
  });

  it('promises no key mechanism that does not exist — and keeps both trial lines in sync', () => {
    renderWelcome();
    expect(screen.queryByText(/time-limited key/)).not.toBeInTheDocument();
    // §7: the trial terms appear in exactly two places — the hero line and
    // the "It isn't finished" card — and must agree.
    expect(screen.getAllByText(/not a free-for-life plan/)).toHaveLength(2);
  });
});
