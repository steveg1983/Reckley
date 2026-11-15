import { useCallback, useSyncExternalStore } from 'react';
import { preferences } from '../services/preferencesService';

/**
 * WIDE VIEW FOR REPORTS (owner, 15 Nov 2026): "On a 12 month income and
 * expenditure report, I would like to be able to see the full 12 months plus
 * the totals at the end."
 *
 * Two caps stood in the way: the page frame (Layout, 1,600px) and each
 * report's own column (1,400px). Wide view lifts both, on report pages only,
 * through two CSS variables they read with their usual width as the fallback:
 *
 *   --page-max    set on <html> while a report is open in wide view
 *   --report-max  set on the report's wrapper, read by every report
 *
 * One choice for every report, remembered in the preferences document so it
 * follows the person to the next report and the next device.
 */

const KEY = 'money_management_reports_wide_view';

const read = (): boolean => preferences.getItem(KEY) === 'true';

export function useReportsWideView(): [boolean, (next: boolean) => void] {
  const wide = useSyncExternalStore(preferences.subscribe, read, read);
  const setWide = useCallback((next: boolean): void => {
    preferences.setItem(KEY, next ? 'true' : 'false');
  }, []);
  return [wide, setWide];
}
