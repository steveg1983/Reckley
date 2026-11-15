import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeftIcon } from '../components/icons';
import PageTip from '../components/PageTip';
import PageWrapper from '../components/PageWrapper';
import PeriodBar from '../components/PeriodBar';
import { SkeletonCard } from '../components/loading/Skeleton';
import { usePeriod, type PeriodKey } from '../hooks/usePeriod';
import { preserveDemoParam } from '../utils/navigation';
import { readProvenance, returnState } from '../utils/navigationProvenance';
import { hasReportArrival, readReportArrival, stripReportArrival } from '../utils/reportDrillLink';
import ReportGallery from './reports/ReportGallery';
import MixedCurrencyDisclosure from '../components/MixedCurrencyDisclosure';
import ReportCurrencyNote from '../components/reports/ReportCurrencyNote';
import { findReport } from './reports/reportRegistry';
import ReportPeriodDefaultToggle from '../components/reports/ReportPeriodDefaultToggle';
import { readReportPeriodDefault } from '../utils/reportPeriodDefaults';
import { useReportPeriodDefault } from '../hooks/useReportPeriodDefault';
import { useReportsWideView } from '../hooks/useReportsWideView';

/** The window a report gets when it states no preference of its own. */
const HUB_DEFAULT_PERIOD: PeriodKey = 'this-month';

/**
 * The reports hub — a gallery of named reports (Microsoft Money's model)
 * rather than a row of tabs, which stops scaling the moment there is more
 * than a handful of reports.
 *
 * The hub owns the shared reporting period and hands it to whichever report
 * is open, so the period PERSISTS as the user moves between reports instead
 * of resetting each time. The CONTROL, though, only appears on a report: on
 * the gallery it changed a window nothing on screen was showing, which is
 * how the owner came to report it as doing nothing (25 Aug). A report may
 * also have its own saved window that outranks the shared one — see
 * utils/reportPeriodDefaults. Each report lives at its own /reports/<id> URL and
 * is code-split, so opening the gallery never loads eight reports' worth of
 * charts.
 *
 * Until the user picks a period, each report opens on the window it is worth
 * reading over (net worth over time on ALL of it, not this month). The moment
 * they pick one, that choice wins everywhere and is never overridden.
 */
/** Lifts every report's own width cap (they read --report-max). */
const WIDE_REPORT_STYLE: React.CSSProperties & { '--report-max': string } = { '--report-max': 'none' };

export default function ReportsHub(): React.JSX.Element {
  const { reportId } = useParams<{ reportId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const report = findReport(reportId);
  const preferredPeriod = report?.defaultPeriod ?? HUB_DEFAULT_PERIOD;

  // One period for the whole hub (storage key shared with the Dashboard's
  // pinned reports, so the two agree about the window as well). The report's
  // preference seeds it on the first paint...
  const picker = usePeriod('reportsPeriod', preferredPeriod);
  const { applyDefaultPeriod, applyArrivalPeriod } = picker;

  // ...and takes effect again when a different report opens without the hub
  // remounting. Both are no-ops once the user has chosen for themselves, or
  // once a drill-down has arrived carrying its own window.
  useEffect(() => {
    applyDefaultPeriod(preferredPeriod);
  }, [applyDefaultPeriod, preferredPeriod]);

  /**
   * A REPORT'S OWN SAVED WINDOW WINS WHEN IT OPENS (owner, 25 Aug).
   *
   * Through `applyArrivalPeriod` rather than `applyDefaultPeriod`, because
   * those two words mean different things here: a surface DEFAULT stands down
   * the moment the user has ever chosen a period for themselves, which is
   * correct for "a window this report is worth reading over" and wrong for
   * "the window this user told this report to open on". A saved default is
   * the user's own instruction and has to outrank their last casual pick
   * elsewhere.
   *
   * It also inherits the property that makes arrival right: it does NOT write
   * to the shared reporting period. Opening a report that remembers Last
   * month must not quietly move every other report to Last month.
   *
   * Keyed on the report id alone, so re-picking the window inside a report
   * does not immediately snap back to the saved one — this fires when the
   * report changes, which is exactly when "opens on" means anything.
   */
  const savedDefaultReportId = report?.id ?? null;
  useEffect(() => {
    if (savedDefaultReportId === null) return;
    const saved = readReportPeriodDefault(savedDefaultReportId);
    if (saved === null) return;
    applyArrivalPeriod(saved.period, saved.customStart, saved.customEnd);
  }, [savedDefaultReportId, applyArrivalPeriod]);

  // The save-as-default control's state, shared with the one report that
  // draws its own period bar (see hooks/useReportPeriodDefault).
  const periodDefault = useReportPeriodDefault(report?.id ?? '', picker);

  // WIDE VIEW (owner, 15 Nov 2026): lifts the page frame's cap while a report
  // is open, and the report's own through --report-max below. See the hook.
  const [wideView, setWideView] = useReportsWideView();
  const isWide = wideView && report !== null;
  useEffect(() => {
    if (!isWide) return undefined;
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--page-max', 'none');
    return () => {
      rootStyle.removeProperty('--page-max');
    };
  }, [isWide]);

  /**
   * What a drill-down from the Dashboard arrived asking for: the window the
   * chart it was clicked on was read over, and the point on it.
   *
   * Consumed ONCE and then taken out of the URL, which is what keeps this from
   * fighting the picker: after the replace the address bar says only which
   * report is open, the user's next click on the period control means what it
   * has always meant, and a reload does not drag them back to the window they
   * arrived on. The report's own stored period is never written to (see
   * applyArrivalPeriod).
   */
  const [focused, setFocused] = useState<{ reportId: string; token: string } | null>(null);
  const arrival = useMemo(() => readReportArrival(location.search), [location.search]);
  useEffect(() => {
    if (!hasReportArrival(arrival) || report === null) return;
    // A report with no period of its own (account distribution is a snapshot of
    // today) is handed none: applying it would silently move the window the
    // NEXT report opens on, from a control this page does not even show.
    if (arrival.period !== null && report.usesPeriod) {
      applyArrivalPeriod(arrival.period, arrival.customStart, arrival.customEnd);
    }
    if (arrival.focus !== null) setFocused({ reportId: report.id, token: arrival.focus });
    // state is carried across the replace by hand: React Router starts a new
    // history entry with null state otherwise, and the provenance that entry is
    // holding is the only thing that knows the way back.
    navigate(
      { pathname: location.pathname, search: stripReportArrival(location.search) },
      { replace: true, state: location.state }
    );
  }, [arrival, report, applyArrivalPeriod, navigate, location.pathname, location.search, location.state]);

  // A point only belongs to the report it was clicked into. Opening another
  // report from the gallery leaves it behind rather than highlighting whatever
  // happens to share the token over there.
  const focus = focused !== null && focused.reportId === reportId ? focused.token : null;

  /**
   * Where the user came from, if they came from somewhere that said so — the
   * Dashboard's cards do. Absent on a bookmark, a typed URL or the gallery,
   * and then the back-link is the hub's own, exactly as before.
   */
  const provenance = readProvenance(location.state);

  // An unknown id (an old bookmark, a typo) returns to the gallery rather
  // than showing an empty frame.
  if (reportId !== undefined && report === null) {
    return <Navigate to={preserveDemoParam('/reports', location.search)} replace />;
  }

  const ReportView = report?.component;

  /**
   * The page's anatomy is the app's anatomy, deliberately.
   *
   * This header used to be a full-bleed white bar clamped to the top of the
   * window — negative margins to escape the layout's padding, a border under
   * it, the heading and the period control inside it. Every other page in the
   * app (Accounts, Budget, Categories, Transactions, Settings) says its name in
   * a plain heading and then stacks content cards under it, so Reports read as
   * a different application to the one the user was in a click ago.
   *
   * It now uses the same PageWrapper as those pages — the identical h1, the
   * identical spacing — and the period control moved into a card of its own,
   * because that is what it is: a control, not part of the page's title. The
   * back-link sits above the heading, where the register's does.
   */
  return (
    <>
      {report && (
        <Link
          to={provenance ? provenance.path : preserveDemoParam('/reports', location.search)}
          state={provenance ? returnState(provenance) : undefined}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors mb-3"
        >
          <ArrowLeftIcon size={16} />
          {provenance ? provenance.label : 'All reports'}
        </Link>
      )}

      <PageWrapper
        title={report ? report.title : 'Reports'}
        headerContent={
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {report
              ? report.description
              : 'Choose a report. Each one carries its own period control.'}
          </p>
        }
        contentClassName="space-y-6"
        rightContent={
          report ? (
            <button
              type="button"
              onClick={() => setWideView(!wideView)}
              aria-pressed={wideView}
              title={wideView ? 'Back to the usual width' : 'Use the whole width of the window'}
              className="hidden md:inline-flex items-center px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors aria-pressed:bg-gray-900 aria-pressed:text-white aria-pressed:border-gray-900 dark:aria-pressed:bg-white dark:aria-pressed:text-gray-900"
            >
              {wideView ? 'Normal width' : 'Wide view'}
            </button>
          ) : undefined
        }
      >
        {/* Named for a screen reader even though it is the only period control
            on the page: out of the header it is no longer read straight after
            the report's title, so it has to say what it governs on its own.

            No card around it any more — see components/PeriodBar. */}
        {/*
            ONLY ON A REPORT, NEVER ON THE GALLERY (owner, 25 Aug: "on the
            front report page doesn't change anything").

            It did do something — it set the window the next report would open
            on — but nothing on the gallery moves when you press it, and a
            control whose effect you cannot see reads as broken. It now
            appears exactly where its effect is visible.
        */}
        {report !== null && (report.usesPeriod ?? true) && !report.ownsPeriodBar && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <PeriodBar picker={picker} label="Reporting period" />
            <ReportPeriodDefaultToggle
              isDefault={periodDefault.isDefault}
              periodLabel={periodDefault.periodLabel}
              onSave={periodDefault.save}
              onClear={periodDefault.clear}
            />
          </div>
        )}

        {ReportView ? (
          <Suspense fallback={<SkeletonCard className="h-96" />}>
            {/* The registry's currency ladder (the disclosure ruling, 22 Aug):
                'self' reports carry their own notes; 'flows' reports get the
                basis line (or the Phase 0 disclosure while degraded); a
                still-native report gets the Phase 0 disclosure. One mount,
                every report — nothing for a single-currency ledger. */}
            {report?.currency === 'flows' && <ReportCurrencyNote />}
            {report?.currency === undefined && <MixedCurrencyDisclosure />}
            <div style={isWide ? WIDE_REPORT_STYLE : undefined}>
              <ReportView picker={picker} focus={focus} />
            </div>
          </Suspense>
        ) : (
          <ReportGallery />
        )}

        {/* What this tip used to carry in its second half — that uncategorised
            rows are left out of the totals — is no longer here. A rule that
            decides whether the figures are the whole story cannot live behind a
            dismiss button, so it is now a permanent line under the Spending
            heading in the gallery (§3.5). The id is deliberately NOT bumped:
            this content is a strict subset of what it already said, so anyone
            who dismissed it has read all of it. */}
        {/* The tip describes the period rule, so it moved on with the control.
            The id is BUMPED because the words changed materially: anyone who
            dismissed the old sentence dismissed a claim about a picker that
            is no longer on this page. */}
        <PageTip
          id="reports-period-3"
          title="Each report remembers its own period"
          description="Pick a window inside a report and it follows you to the next one. If a report is always worth reading over the same window, save it there and that report will open on it."
        />
      </PageWrapper>
    </>
  );
}
