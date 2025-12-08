-- ============================================
-- RATE LIMITS CLEANUP CRON JOB
-- ============================================
-- Sets up a weekly cron job to clean old rate limit records
-- This prevents the rate_limits table from growing indefinitely

-- Enable pg_cron extension (if not already enabled)
-- Note: pg_cron may need to be enabled by Supabase support for your project
-- If this fails, contact Supabase support to enable pg_cron extension
-- For self-hosted Supabase, pg_cron should be available by default
--
-- If pg_cron is not available, see docs/RATE_LIMITS_CLEANUP.md for alternative approaches
DO $$
BEGIN
  -- Try to enable pg_cron, but don't fail if it's not available
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron extension not available. Cron jobs will not be scheduled.';
    RAISE NOTICE 'See docs/RATE_LIMITS_CLEANUP.md for alternative cleanup methods.';
END $$;

-- Schedule weekly cleanup job (only if pg_cron is available)
-- Runs every Sunday at 2:00 AM UTC (low traffic time)
-- Cron format: minute hour day-of-month month day-of-week
-- 0 = Sunday, 1 = Monday, ..., 6 = Saturday
DO $schedule$
BEGIN
  -- Check if pg_cron is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Schedule weekly cleanup job
    -- Use single quotes with escaped single quotes for the SQL command
    PERFORM cron.schedule(
      'clean-old-rate-limits-weekly',
      '0 2 * * 0',  -- Every Sunday at 2:00 AM UTC
      'SELECT public.clean_old_rate_limits()'
    );

    -- Optional: Also set up a daily cleanup job as a backup
    -- This ensures records are cleaned even if weekly job fails
    -- Runs every day at 3:00 AM UTC
    PERFORM cron.schedule(
      'clean-old-rate-limits-daily',
      '0 3 * * *',  -- Every day at 3:00 AM UTC
      'SELECT public.clean_old_rate_limits()'
    );

    RAISE NOTICE 'Cron jobs scheduled successfully.';
  ELSE
    RAISE NOTICE 'pg_cron extension not available. Cron jobs not scheduled.';
    RAISE NOTICE 'See docs/RATE_LIMITS_CLEANUP.md for alternative cleanup methods.';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Failed to schedule cron jobs: %', SQLERRM;
    RAISE NOTICE 'See docs/RATE_LIMITS_CLEANUP.md for alternative cleanup methods.';
END $schedule$;

-- ============================================
-- MONITORING QUERIES
-- ============================================
-- Use these queries to monitor the rate_limits table and cron jobs

-- View all scheduled cron jobs:
-- SELECT * FROM cron.job;

-- View cron job execution history:
-- SELECT * FROM cron.job_run_details
-- WHERE jobname IN ('clean-old-rate-limits-weekly', 'clean-old-rate-limits-daily')
-- ORDER BY start_time DESC
-- LIMIT 20;

-- Check current size of rate_limits table:
-- SELECT
--   COUNT(*) as total_records,
--   COUNT(DISTINCT identifier) as unique_identifiers,
--   COUNT(DISTINCT endpoint) as unique_endpoints,
--   MIN(window_start) as oldest_record,
--   MAX(window_start) as newest_record
-- FROM public.rate_limits;

-- Check records that will be cleaned (older than 24 hours):
-- SELECT COUNT(*) as records_to_clean
-- FROM public.rate_limits
-- WHERE window_start < NOW() - INTERVAL '24 hours';

-- Manually run cleanup (for testing):
-- SELECT public.clean_old_rate_limits();

-- To unschedule a job:
-- SELECT cron.unschedule('clean-old-rate-limits-weekly');
-- SELECT cron.unschedule('clean-old-rate-limits-daily');
