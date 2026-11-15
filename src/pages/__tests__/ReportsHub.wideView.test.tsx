/**
 * WIDE VIEW (owner, 15 Nov 2026): "see the full 12 months plus the totals at
 * the end". The toggle lifts the page frame's cap (--page-max on <html>) and
 * the report's own (--report-max on its wrapper), only while a report is open,
 * and is remembered. Every figure invented.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PreferencesProvider } from '../../contexts/PreferencesContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { __setAppContextValue, __resetAppContextValue } from '../../test/mocks/AppContextSupabase';
import { preferences } from '../../services/preferencesService';
import ReportsHub from '../ReportsHub';

const renderHub = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <PreferencesProvider>
        <ToastProvider>
          <Routes>
            <Route path="/reports" element={<ReportsHub />} />
            <Route path="/reports/:reportId" element={<ReportsHub />} />
          </Routes>
        </ToastProvider>
      </PreferencesProvider>
    </MemoryRouter>
  );

beforeEach(() => {
  localStorage.clear();
  preferences.removeItem('money_management_reports_wide_view');
  __setAppContextValue({ accounts: [], transactions: [], categories: [], transactionSplits: [] });
});

afterEach(() => {
  cleanup();
  __resetAppContextValue();
  document.documentElement.style.removeProperty('--page-max');
});

describe('Reports — wide view', () => {
  it('a report offers Wide view; pressing it lifts the page width, and pressing again puts it back', () => {
    renderHub('/reports/account-balances');
    const toggle = screen.getByRole('button', { name: 'Wide view' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement.style.getPropertyValue('--page-max')).toBe('');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Normal width' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.style.getPropertyValue('--page-max')).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: 'Normal width' }));
    expect(document.documentElement.style.getPropertyValue('--page-max')).toBe('');
  });

  it('is remembered for the next report, and lets go of the page when you leave', () => {
    renderHub('/reports/account-balances');
    fireEvent.click(screen.getByRole('button', { name: 'Wide view' }));
    cleanup();
    expect(document.documentElement.style.getPropertyValue('--page-max')).toBe('');

    renderHub('/reports/spending-by-category');
    expect(screen.getByRole('button', { name: 'Normal width' })).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--page-max')).toBe('none');
  });

  it('the gallery has no toggle and is never widened', () => {
    preferences.setItem('money_management_reports_wide_view', 'true');
    renderHub('/reports');
    expect(screen.queryByRole('button', { name: /Wide view|Normal width/ })).not.toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--page-max')).toBe('');
  });
});
