-- linked_accounts.pending_items / pending_as_of, on a real server.
--
-- 20261110090000 adds the two columns the account sync writes a card's
-- pending items to. This file is the write the sync makes and the three it
-- must never be able to make — because the last table added without one real
-- INSERT in a test (push_devices) refused every row for two months.
\set ON_ERROR_STOP on
\timing off

\set OWNER '''e1000000-0000-0000-0000-000000000001'''
\set CONN  '''e2000000-0000-0000-0000-000000000001'''
\set ACCT  '''e3000000-0000-0000-0000-000000000001'''

DELETE FROM public.linked_accounts WHERE connection_id = :CONN;
DELETE FROM public.bank_connections WHERE id = :CONN;
DELETE FROM public.accounts WHERE id = :ACCT;
DELETE FROM public.users WHERE id = :OWNER;

INSERT INTO public.users (id, clerk_id, email) VALUES (:OWNER, 'clerk_pending', 'pending@example.test');
INSERT INTO public.accounts (id, user_id, name, type) VALUES (:ACCT, :OWNER, 'Test Card', 'credit');
INSERT INTO public.bank_connections
  (id, user_id, provider, institution_id, institution_name, access_token_encrypted, status, needs_reauth)
VALUES (:CONN, :OWNER, 'truelayer', 'inst-card', 'Card Issuer', 'x', 'connected', false);
INSERT INTO public.linked_accounts (connection_id, account_id, external_account_id, external_kind)
VALUES (:CONN, :ACCT, 'ext-card-1', 'card');

-- A link nobody has read pending items for holds neither column.
SELECT pending_items IS NULL AND pending_as_of IS NULL AS starts_empty
FROM public.linked_accounts WHERE connection_id = :CONN;

-- The sync's write: the items and the moment they were read.
UPDATE public.linked_accounts
SET pending_items = '[{"date":"2026-11-09","description":"CAFE","amount":-3.20},{"date":null,"description":"REFUND","amount":10}]'::jsonb,
    pending_as_of = '2026-11-10T09:07:00Z'
WHERE connection_id = :CONN AND external_account_id = 'ext-card-1';

SELECT jsonb_array_length(pending_items) = 2 AS two_items_present,
       (pending_items -> 0 ->> 'amount')::numeric = -3.20 AS amount_preserved
FROM public.linked_accounts WHERE connection_id = :CONN;

-- "The bank said nothing pending" is an empty array WITH a date — a reading.
UPDATE public.linked_accounts SET pending_items = '[]'::jsonb, pending_as_of = now()
WHERE connection_id = :CONN;
SELECT jsonb_array_length(pending_items) = 0 AS empty_reading_present
FROM public.linked_accounts WHERE connection_id = :CONN;

-- The refusals, each caught and reported so the file runs to its end.
CREATE OR REPLACE FUNCTION pg_temp.pending_refused(p_items jsonb, p_as_of timestamptz) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.linked_accounts SET pending_items = p_items, pending_as_of = p_as_of
  WHERE connection_id = 'e2000000-0000-0000-0000-000000000001';
  RETURN false;
EXCEPTION WHEN check_violation THEN
  RETURN true;
END $$;

SELECT pg_temp.pending_refused('[{"amount":1}]'::jsonb, NULL)   AS items_without_date_refused_correct;
SELECT pg_temp.pending_refused(NULL, now())                      AS date_without_items_refused_correct;
SELECT pg_temp.pending_refused('{"amount":1}'::jsonb, now())     AS non_array_refused_correct;

-- Clearing both — what an unanswered sync writes — is allowed.
UPDATE public.linked_accounts SET pending_items = NULL, pending_as_of = NULL WHERE connection_id = :CONN;
SELECT pending_items IS NULL AND pending_as_of IS NULL AS cleared_empty
FROM public.linked_accounts WHERE connection_id = :CONN;

DELETE FROM public.linked_accounts WHERE connection_id = :CONN;
DELETE FROM public.bank_connections WHERE id = :CONN;
DELETE FROM public.accounts WHERE id = :ACCT;
DELETE FROM public.users WHERE id = :OWNER;
