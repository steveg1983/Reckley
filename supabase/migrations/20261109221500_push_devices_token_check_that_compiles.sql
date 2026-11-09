-- push_devices: a token check PostgreSQL can actually evaluate.
--
-- 20260911170000 declared
--
--     CONSTRAINT push_devices_token_is_hex CHECK (token ~ '^[0-9a-fA-F]{16,512}$')
--
-- and PostgreSQL's regular expressions cap a repetition count at 255
-- (DUPMAX). CREATE TABLE accepted it — a CHECK's expression is parsed then,
-- but a regex literal is only COMPILED when a row is tested — so the
-- constraint sat in the catalogue for two months and failed every insert it
-- ever saw with
--
--     ERROR: invalid regular expression: invalid repetition count(s)
--
-- No phone could register. It went unseen because nothing reached the insert
-- until 9 Nov 2026: the client hung one step earlier (the plugin proxy handed
-- to a promise bare — #632), and the first phone past that fix was the first
-- row this table was ever offered. The settings card printed the message
-- above on the owner's phone the same evening.
--
-- The intent is unchanged — hex, and a generous length, because Apple says
-- not to assume 64 — but the length is now arithmetic and the regex only
-- names the alphabet, so there is no count to exceed.
--
-- The table is empty (it could not be otherwise), so the new check has no
-- existing row to validate. scripts/local-db/push-devices.test.sql inserts a
-- 64- and a 160-character token and refuses a non-hex and a short one: the
-- test the original needed was one INSERT.

ALTER TABLE public.push_devices
  DROP CONSTRAINT IF EXISTS push_devices_token_is_hex;

ALTER TABLE public.push_devices
  ADD CONSTRAINT push_devices_token_is_hex
  CHECK (token ~ '^[0-9a-fA-F]+$' AND char_length(token) BETWEEN 16 AND 512);
