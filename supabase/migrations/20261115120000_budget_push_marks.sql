-- budget_push_marks: which budgets the server has already told a phone about,
-- in which band, in which period.
--
-- The owner, 15 Nov 2026: budget alerts existed only inside the app, raised
-- when the Budget page was opened; he asked for them on the phone. The
-- reminders cron now evaluates each listening person's running budgets every
-- quarter-hour (api/_lib/budget-push.ts), and this table is what makes it say
-- each thing ONCE:
--
--   * a row per budget announced: the band ('near' at the Budget Alerts
--     threshold, 'over' at 100%) and the start of the period it was in;
--   * a budget is announced again only on moving from near to over in the
--     same period, or in a new period;
--   * the row goes when the budget drops back below the threshold or stops
--     running, which re-arms it.
--
-- Nobody but the server reads or writes it. RLS on with no policy, and the
-- browser roles hold no grant. Holds no amounts.

DO $$
BEGIN
  IF to_regclass('public.budgets') IS NULL OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'wrong_base_missing_budgets: public.budgets or public.users does not exist.'
      USING ERRCODE = 'P0001',
            HINT = 'Apply the migrations in order with `npm run db:migrate`.';
  END IF;
  IF to_regclass('public.budget_push_marks') IS NOT NULL THEN
    RAISE EXCEPTION 'budget_push_marks_already_exists: this migration has already been applied and must not run twice.'
      USING ERRCODE = 'P0001',
            HINT = 'If something needs changing, write a new migration for it.';
  END IF;
END
$$;

CREATE TABLE public.budget_push_marks (
  budget_id     uuid PRIMARY KEY REFERENCES public.budgets(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  band          text NOT NULL,
  period_start  date NOT NULL,
  notified_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT budget_push_marks_band CHECK (band IN ('near', 'over'))
);

CREATE INDEX budget_push_marks_user_idx ON public.budget_push_marks (user_id);

COMMENT ON TABLE public.budget_push_marks IS
  'One row per budget the server has pushed a notification for: the band (near/over) and the period it was in, so each is announced once; deleted when the budget drops back or stops running. Service-role only. Holds no amounts.';

ALTER TABLE public.budget_push_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.budget_push_marks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.budget_push_marks TO service_role;
