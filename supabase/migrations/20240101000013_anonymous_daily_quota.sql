-- ============================================
-- ANONYMOUS USER DAILY CREATION TRACKING
-- ============================================
-- Tracks daily creation limits for non-logged-in users using IP address
-- Uses the existing rate_limits table with a daily window (1440 minutes)

-- ============================================
-- FUNCTION: Get Anonymous Daily Creation Quota
-- ============================================
-- Returns daily creation quota info for anonymous users (by IP)
-- Uses rate_limits table with endpoint 'generate' and 1440 minute window (24 hours)
CREATE OR REPLACE FUNCTION public.get_anonymous_daily_quota(p_ip_address text)
RETURNS TABLE (
  creations_used_today integer,
  creations_remaining_today integer,
  creations_daily_limit integer,
  reset_at timestamptz
) AS $$
DECLARE
  v_identifier text;
  v_daily_limit integer := 10; -- Daily limit for anonymous users
  v_window_start timestamptz;
  v_reset_at timestamptz;
  v_current_count integer := 0;
BEGIN
  -- Format identifier as IP
  v_identifier := 'ip:' || p_ip_address;

  -- Calculate window start (start of current day UTC)
  v_window_start := date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  -- Calculate reset time (start of next day UTC)
  v_reset_at := v_window_start + INTERVAL '1 day';

  -- Get current count for today (sum all rate limit entries since start of day)
  -- This works regardless of the window boundaries used by check_rate_limit
  SELECT COALESCE(SUM(request_count), 0) INTO v_current_count
  FROM public.rate_limits
  WHERE identifier = v_identifier
    AND endpoint = 'generate'
    AND created_at >= v_window_start;

  -- Return quota info
  RETURN QUERY SELECT
    v_current_count::integer as creations_used_today,
    GREATEST(0, v_daily_limit - v_current_count)::integer as creations_remaining_today,
    v_daily_limit::integer as creations_daily_limit,
    v_reset_at as reset_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Check Anonymous Daily Creation Limit
-- ============================================
-- Checks if anonymous user (by IP) can create (has daily quota remaining)
-- Returns true if allowed, false if limit exceeded
CREATE OR REPLACE FUNCTION public.check_anonymous_daily_creation_limit(
  p_ip_address text,
  p_daily_limit integer DEFAULT 10
)
RETURNS boolean AS $$
DECLARE
  v_identifier text;
  v_window_start timestamptz;
  v_current_count integer := 0;
BEGIN
  -- Format identifier as IP
  v_identifier := 'ip:' || p_ip_address;

  -- Calculate window start (start of current day UTC)
  v_window_start := date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  -- Get current count for today (sum all rate limit entries since start of day)
  -- This works regardless of the window boundaries used by check_rate_limit
  SELECT COALESCE(SUM(request_count), 0) INTO v_current_count
  FROM public.rate_limits
  WHERE identifier = v_identifier
    AND endpoint = 'generate'
    AND created_at >= v_window_start;

  -- Check if limit exceeded
  RETURN v_current_count < p_daily_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
