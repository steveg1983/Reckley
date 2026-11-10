-- widget_keys: the read-only key a home-screen widget asks the server with.
--
-- A widget is native code outside the app's web view. It has no Clerk
-- session and cannot get one, and the owner's ruling (10 Nov 2026) is that it
-- fetches for itself — so it is fresh while the bank feeds run in the
-- background and nobody has the app open. It therefore needs a credential of
-- its own, and this is the narrowest one that works:
--
--   * minted by a signed-in app (POST /api/widget/key), shown once, and never
--     stored here: the row holds a SHA-256 of it, so a copy of this table
--     opens nothing;
--   * good for ONE route (GET /api/widget/budgets), which answers a summary
--     of the running budgets and nothing else — no transactions, no
--     accounts, no net worth, no writes;
--   * revoked by a date, not deleted, so "which key was that" still has an
--     answer afterwards.
--
-- Nobody but the server reads or writes it. RLS is on with no policy, and the
-- browser roles hold no grant: a signed-in browser cannot list its own keys'
-- hashes, because nothing it does needs them.
--
-- Holds no financial data.

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'wrong_base_missing_users: public.users does not exist.'
      USING ERRCODE = 'P0001',
            HINT = 'Apply the migrations in order with `npm run db:migrate`.';
  END IF;
  IF to_regclass('public.widget_keys') IS NOT NULL THEN
    RAISE EXCEPTION 'widget_keys_already_exists: this migration has already been applied and must not run twice.'
      USING ERRCODE = 'P0001',
            HINT = 'If something needs changing, write a new migration for it.';
  END IF;
END
$$;

CREATE TABLE public.widget_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- SHA-256 of the key, lower-case hex. The key itself is never stored.
  key_hash     text NOT NULL,
  -- What the phone called itself when it asked ("iPhone"), for a list a
  -- person can read. Nothing depends on it.
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Stamped by the budgets route, at most once an hour per key.
  last_used_at timestamptz,
  revoked_at   timestamptz,

  CONSTRAINT widget_keys_hash_unique UNIQUE (key_hash),
  -- Length and alphabet apart: a counted repetition above 255 is a regex
  -- PostgreSQL refuses only when a row is tested (see 20261109221500). 64 is
  -- under the cap, and the habit is kept anyway.
  CONSTRAINT widget_keys_hash_is_sha256 CHECK (key_hash ~ '^[0-9a-f]+$' AND char_length(key_hash) = 64),
  CONSTRAINT widget_keys_label_short CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80)
);

CREATE INDEX widget_keys_user_active_idx
  ON public.widget_keys (user_id, created_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.widget_keys IS
  'One row per read-only key a home-screen widget holds: a SHA-256 of the key, whose it is, and whether it has been revoked. The key opens GET /api/widget/budgets and nothing else. Server-only: RLS on, no policy, no grant to the browser roles. Holds no financial data.';

ALTER TABLE public.widget_keys ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.widget_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.widget_keys TO service_role;
