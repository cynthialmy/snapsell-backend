-- ============================================
-- FUNCTION: Check Rate Limit (Read-Only)
-- ============================================
-- Checks rate limit WITHOUT incrementing the counter
-- Use this for checking if a request would be allowed
-- Returns: allowed (boolean), remaining (integer), reset_at (timestamptz), current_count (integer)
CREATE OR REPLACE FUNCTION public.check_rate_limit_readonly(
  p_identifier text,
  p_endpoint text,
  p_limit integer,
  p_window_minutes integer
)
RETURNS TABLE (
  allowed boolean,
  remaining integer,
  reset_at timestamptz,
  current_count integer
) AS $$
DECLARE
  v_window_start timestamptz;
  v_current_count integer := 0;
  v_reset_at timestamptz;
BEGIN
  -- Calculate window start (round down to nearest window boundary)
  v_window_start := date_trunc('minute', NOW()) -
    (EXTRACT(MINUTE FROM NOW())::integer % p_window_minutes || ' minutes')::interval;

  -- Calculate reset time (end of current window)
  v_reset_at := v_window_start + (p_window_minutes || ' minutes')::interval;

  -- Get current count WITHOUT incrementing
  -- If no record exists, v_current_count stays 0 (default value)
  SELECT COALESCE(SUM(request_count), 0) INTO v_current_count
  FROM public.rate_limits
  WHERE identifier = p_identifier
    AND endpoint = p_endpoint
    AND window_start = v_window_start;

  -- Check if limit is exceeded
  -- For a new IP with no records, v_current_count = 0, so allowed = true, remaining = limit
  RETURN QUERY SELECT
    (v_current_count < p_limit)::boolean as allowed,
    GREATEST(0, p_limit - v_current_count)::integer as remaining,
    v_reset_at as reset_at,
    v_current_count::integer as current_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
