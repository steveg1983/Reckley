-- widget_keys accepts a real-shaped row, on a real server, and refuses the
-- shapes its checks exist for. Every new table gets one real INSERT here:
-- push_devices went two months unable to take a row because nothing had ever
-- offered it one (see push-devices.test.sql).
\set ON_ERROR_STOP on
\timing off

\set OWNER '''d2000000-0000-0000-0000-000000000002'''

DELETE FROM public.users WHERE id = :OWNER;
INSERT INTO public.users (id, clerk_id, email) VALUES (:OWNER, 'clerk_widget', 'widget@example.test');

-- A SHA-256, as the server writes it.
INSERT INTO public.widget_keys (user_id, key_hash, label)
VALUES (:OWNER, encode(sha256('an invented key'::bytea), 'hex'), 'iPhone');

SELECT count(*) = 1 AS key_row_present FROM public.widget_keys WHERE user_id = :OWNER;

CREATE OR REPLACE FUNCTION pg_temp.key_refused(p_hash text, p_label text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.widget_keys (user_id, key_hash, label)
  VALUES ('d2000000-0000-0000-0000-000000000002', p_hash, p_label);
  RETURN false;
EXCEPTION WHEN check_violation OR unique_violation THEN
  RETURN true;
END $$;

SELECT pg_temp.key_refused(repeat('a', 63))                                   AS short_hash_refused_correct;
SELECT pg_temp.key_refused(repeat('A', 64))                                   AS upper_case_hash_refused_correct;
SELECT pg_temp.key_refused(repeat('g', 64))                                   AS non_hex_hash_refused_correct;
SELECT pg_temp.key_refused(encode(sha256('an invented key'::bytea), 'hex'))   AS duplicate_hash_refused_correct;
SELECT pg_temp.key_refused(repeat('b', 64), repeat('x', 81))                  AS long_label_refused_correct;
SELECT pg_temp.key_refused(repeat('c', 64), '')                               AS empty_label_refused_correct;

SELECT count(*) = 1 AS refusals_left_table_untouched FROM public.widget_keys WHERE user_id = :OWNER;

-- Server-only: the browser roles hold no privilege on it at all.
SELECT NOT has_table_privilege('authenticated', 'public.widget_keys', 'SELECT') AS authenticated_cannot_read_correct;
SELECT NOT has_table_privilege('anon', 'public.widget_keys', 'SELECT')          AS anon_cannot_read_correct;
SELECT relrowsecurity AS rls_is_on FROM pg_class WHERE oid = 'public.widget_keys'::regclass;

-- The account's erasure takes its keys with it.
DELETE FROM public.users WHERE id = :OWNER;
SELECT count(*) = 0 AS keys_went_with_the_user FROM public.widget_keys WHERE user_id = :OWNER;
