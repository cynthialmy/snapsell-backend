-- ============================================
-- DAILY CREATION RESET FUNCTION
-- ============================================
-- Resets daily creation quota for all free users at midnight UTC

CREATE OR REPLACE FUNCTION public.reset_daily_creations()
RETURNS integer AS $$
DECLARE
  v_reset_count integer := 0;
  v_now timestamptz := now();
BEGIN
  -- Reset creations_remaining_today for free users where last reset was before today
  UPDATE public.user_quota uq
  SET
    creations_remaining_today = 10,
    last_creation_reset = v_now,
    updated_at = v_now
  FROM public.users_profile up
  WHERE uq.user_id = up.id
    AND up.plan != 'pro'
    AND DATE(uq.last_creation_reset AT TIME ZONE 'UTC') < CURRENT_DATE;

  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  RETURN v_reset_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- CRON JOB SETUP
-- ============================================
-- Enable pg_cron extension (if not already enabled)
-- Note: pg_cron may need to be enabled by Supabase support for your project
-- If this fails, contact Supabase support to enable pg_cron extension
-- For self-hosted Supabase, pg_cron should be available by default
DO $$
BEGIN
  -- Try to enable pg_cron, but don't fail if it's not available
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron extension not available. Cron jobs will not be scheduled.';
    RAISE NOTICE 'You can manually run: SELECT public.reset_daily_creations();';
    RAISE NOTICE 'Or set up via Supabase Dashboard → Database → Cron Jobs';
END $$;

-- Schedule daily reset job (only if pg_cron is available)
-- Runs every day at midnight UTC
-- Cron format: minute hour day-of-month month day-of-week
-- * = every, so '0 0 * * *' = every day at 00:00 UTC
DO $schedule$
BEGIN
  -- Check if pg_cron is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Schedule daily reset job
    PERFORM cron.schedule(
      'reset-daily-creations',
      '0 0 * * *',  -- Every day at midnight UTC
      'SELECT public.reset_daily_creations()'
    );

    RAISE NOTICE 'Daily creation reset cron job scheduled successfully.';
  ELSE
    RAISE NOTICE 'pg_cron extension not available. Cron jobs not scheduled.';
    RAISE NOTICE 'You can manually run: SELECT public.reset_daily_creations();';
    RAISE NOTICE 'Or set up via Supabase Dashboard → Database → Cron Jobs';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Failed to schedule cron job: %', SQLERRM;
    RAISE NOTICE 'You can manually run: SELECT public.reset_daily_creations();';
END $schedule$;

-- ============================================
-- MONITORING QUERIES
-- ============================================
-- Use these queries to monitor the cron job

-- View all scheduled cron jobs:
-- SELECT * FROM cron.job WHERE jobname = 'reset-daily-creations';

-- View cron job execution history:
-- SELECT jrd.*
-- FROM cron.job_run_details jrd
-- JOIN cron.job j ON jrd.jobid = j.jobid
-- WHERE j.jobname = 'reset-daily-creations'
-- ORDER BY jrd.start_time DESC
-- LIMIT 20;

-- Manually run the reset function (for testing):
-- SELECT public.reset_daily_creations();
