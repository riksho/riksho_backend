-- Migration: 019_push_tokens_multidevice.sql
-- Description: Fix (A1) — push_tokens had user_id as PRIMARY KEY, so one user could
--              store exactly one token. The driver app registered TWICE at startup
--              (Expo token via POST /push/register from app/index.tsx, FCM token via
--              POST /push/fcm-register from app/_layout.tsx), and the two upserts
--              overwrote each other non-deterministically on every launch.
--
--              sendPush() — the function that notifies drivers of new ride offers —
--              posts to Expo's API without filtering token_type. When the FCM
--              registration won the race, Expo received a raw FCM token, rejected it,
--              and the ride offer was silently dropped.
--
--              This migration:
--                1. Repoints the PK to (user_id, token) so a driver can have a phone
--                   AND a tablet, which the old schema silently could not support.
--                2. Purges every non-FCM row. The platform is standardising on FCM
--                   (both apps already ship @react-native-firebase/messaging +
--                   google-services.json). Cleared rows re-register on next launch.
--                3. Backfills token_type = 'fcm' on legacy NULL rows and makes the
--                   column NOT NULL so an untyped token can never be sent again.
--
-- Idempotent: safe to re-run.
--
-- ⚠️  EXPECTED SIDE EFFECT: every user loses their stored push token and will not
--     receive pushes until they next open the app (which re-registers immediately
--     via registerPushToken()). This is intentional — the old rows are an
--     indistinguishable mix of Expo and FCM tokens with no reliable way to tell
--     them apart, so keeping them would preserve the bug.

-- ------------------------------------------------------------
-- 1. Purge non-FCM tokens.
--   Legacy rows written by POST /push/register have token_type NULL (that route
--   never set the column) or 'expo'. Expo tokens are also identifiable by their
--   ExponentPushToken[...] / ExpoPushToken[...] wrapper, so we catch them by
--   shape too, in case any were inserted with token_type wrongly set to 'fcm'.
-- ------------------------------------------------------------
DELETE FROM public.push_tokens
WHERE token_type IS NULL
   OR token_type <> 'fcm'
   OR token LIKE 'ExponentPushToken%'
   OR token LIKE 'ExpoPushToken%';

-- ------------------------------------------------------------
-- 2. Repoint the primary key to (user_id, token).
--   Discover the existing PK name rather than assuming 'push_tokens_pkey'.
-- ------------------------------------------------------------
DO $$
DECLARE
  pk_name TEXT;
BEGIN
  SELECT con.conname INTO pk_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'push_tokens'
    AND con.contype = 'p';

  IF pk_name IS NOT NULL THEN
    -- Only drop if it is the old single-column (user_id) PK. If it already
    -- covers 2 columns, this migration has already run.
    IF (SELECT cardinality(con.conkey) FROM pg_constraint con WHERE con.conname = pk_name) = 1 THEN
      EXECUTE format('ALTER TABLE public.push_tokens DROP CONSTRAINT %I', pk_name);
      RAISE NOTICE 'Dropped single-column primary key: %', pk_name;
    ELSE
      RAISE NOTICE 'Primary key % already spans multiple columns — skipping.', pk_name;
    END IF;
  END IF;
END $$;

-- Deduplicate before adding the composite key, in case the same (user_id, token)
-- pair somehow exists twice (possible only if the PK was dropped by hand earlier).
DELETE FROM public.push_tokens a
USING public.push_tokens b
WHERE a.ctid < b.ctid
  AND a.user_id = b.user_id
  AND a.token = b.token;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'push_tokens' AND con.contype = 'p'
  ) THEN
    ALTER TABLE public.push_tokens ADD PRIMARY KEY (user_id, token);
    RAISE NOTICE 'Added composite primary key (user_id, token).';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Lock token_type down to a known value.
--   Everything surviving step 1 is FCM. Backfill defensively, then enforce.
-- ------------------------------------------------------------
UPDATE public.push_tokens SET token_type = 'fcm' WHERE token_type IS NULL;

ALTER TABLE public.push_tokens ALTER COLUMN token_type SET DEFAULT 'fcm';
ALTER TABLE public.push_tokens ALTER COLUMN token_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'push_tokens_token_type_check'
  ) THEN
    ALTER TABLE public.push_tokens
      ADD CONSTRAINT push_tokens_token_type_check CHECK (token_type IN ('fcm'));
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Index for the hot path: sendPush() looks up tokens by user_id.
--   The composite PK (user_id, token) already serves user_id-prefixed lookups,
--   so no extra index is needed. Documented here so nobody adds a redundant one.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 5. RLS. push_tokens had RLS left DISABLED by 016 (only push_history got it).
--   The backend writes with the service_role key, which bypasses RLS, so
--   enabling it costs nothing operationally and stops the anon/authenticated
--   roles from reading other users' device tokens directly via the REST API.
-- ------------------------------------------------------------
ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own push tokens" ON public.push_tokens;
CREATE POLICY "Users can view own push tokens" ON public.push_tokens
  FOR SELECT USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies: all writes go through the backend's
-- service_role key via POST /push/fcm-register.

-- ------------------------------------------------------------
-- Verification (run manually after applying):
--
--   SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con
--   JOIN pg_class rel ON rel.oid = con.conrelid
--   WHERE rel.relname = 'push_tokens' AND con.contype = 'p';
--   -- expect: PRIMARY KEY (user_id, token)
--
--   SELECT token_type, count(*) FROM public.push_tokens GROUP BY token_type;
--   -- expect: only 'fcm' (or zero rows immediately after migrating)
-- ------------------------------------------------------------
