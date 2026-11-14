-- low_balance_marks: which accounts the server has already told a phone are
-- past their warning line.
--
-- The owner, 14 Nov 2026: the Dashboard's "Needs your attention" card had
-- warned of a low balance for days and the phone had never said a word —
-- because nothing on the server ever looked. api/_lib/low-balance-push.ts now
-- looks every quarter-hour, and this table is what makes it say so ONCE:
--
--   * a row exists while an account is past its line and the push has gone;
--   * it is deleted when the account comes back (or the warning is switched
--     off), which re-arms the push for the next crossing.
--
-- Nobody but the server reads or writes it. RLS on with no policy, and the
-- browser roles hold no grant. Holds no amounts.

DO $$
BEGIN
  IF to_regclass('public.accounts') IS NULL OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'wrong_base_missing_accounts: public.accounts or public.users does not exist.'
      USING ERRCODE = 'P0001',
            HINT = 'Apply the migrations in order with `npm run db:migrate`.';
  END IF;
  IF to_regclass('public.low_balance_marks') IS NOT NULL THEN
    RAISE EXCEPTION 'low_balance_marks_already_exists: this migration has already been applied and must not run twice.'
      USING ERRCODE = 'P0001',
            HINT = 'If something needs changing, write a new migration for it.';
  END IF;
END
$$;

CREATE TABLE public.low_balance_marks (
  account_id   uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notified_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX low_balance_marks_user_idx ON public.low_balance_marks (user_id);

COMMENT ON TABLE public.low_balance_marks IS
  'One row per account the server has pushed a "past your warning line" notification for, kept while it stays past the line and deleted when it comes back, so each crossing is announced once. Service-role only. Holds no amounts.';

ALTER TABLE public.low_balance_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.low_balance_marks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.low_balance_marks TO service_role;
