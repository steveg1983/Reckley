-- push_devices accepts a real-shaped APNs token, on a real server.
--
-- The table's first token check (20260911170000) was a regex with a
-- repetition count of 512; PostgreSQL caps those at 255 and only finds out
-- when a row is tested, so every insert failed for two months and nothing
-- noticed, because nothing had ever inserted. This file is the INSERT that
-- would have caught it, plus the refusals the check exists for.
-- 20261109221500 is the correction.
\set ON_ERROR_STOP on
\timing off

\set PHONE '''d1000000-0000-0000-0000-000000000001'''

DELETE FROM public.push_devices WHERE user_id = :PHONE;
DELETE FROM public.users WHERE id = :PHONE;
INSERT INTO public.users (id, clerk_id, email) VALUES (:PHONE, 'clerk_phone', 'phone@example.test');

-- 64 hex characters: what APNs hands out today.
INSERT INTO public.push_devices (user_id, platform, token)
VALUES (:PHONE, 'ios', repeat('0a1B', 16));

-- 160: Apple says not to assume the length, and tokens have grown before.
INSERT INTO public.push_devices (user_id, platform, token)
VALUES (:PHONE, 'ios', repeat('c3D4e', 32));

SELECT count(*) = 2 AS both_tokens_present FROM public.push_devices WHERE user_id = :PHONE;

-- The refusals. Each is caught and reported as a boolean, so the file runs
-- to its end and a refusal that stops happening prints f.
CREATE OR REPLACE FUNCTION pg_temp.token_refused(p_token text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.push_devices (user_id, platform, token)
  VALUES ('d1000000-0000-0000-0000-000000000001', 'ios', p_token);
  RETURN false;
EXCEPTION WHEN check_violation THEN
  RETURN true;
END $$;

SELECT pg_temp.token_refused('not-a-hex-token-at-all!') AS non_hex_refused_correct;
SELECT pg_temp.token_refused('abc123')                  AS too_short_refused_correct;
SELECT pg_temp.token_refused(repeat('a', 513))          AS too_long_refused_correct;

SELECT count(*) = 2 AS refusals_left_table_untouched FROM public.push_devices WHERE user_id = :PHONE;

DELETE FROM public.push_devices WHERE user_id = :PHONE;
DELETE FROM public.users WHERE id = :PHONE;
