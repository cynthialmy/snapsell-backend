-- ============================================
-- FIX: Check Rate Limit Readonly - Handle NULL values
-- ============================================
-- Fixes the issue where new IPs get null values instead of proper defaults
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
  -- If no record exists, SUM returns NULL, so COALESCE to 0
  SELECT COALESCE(SUM(request_count), 0) INTO v_current_count
  FROM public.rate_limits
  WHERE identifier = p_identifier
    AND endpoint = p_endpoint
    AND window_start = v_window_start;

  -- Ensure v_current_count is never NULL (defensive check)
  IF v_current_count IS NULL THEN
    v_current_count := 0;
  END IF;

  -- Ensure v_current_count is a valid integer
  v_current_count := COALESCE(v_current_count, 0)::integer;

  -- Check if limit is exceeded
  -- For a new IP with no records, v_current_count = 0, so allowed = true, remaining = limit
  RETURN QUERY SELECT
    (v_current_count < p_limit)::boolean as allowed,
    GREATEST(0, p_limit - v_current_count)::integer as remaining,
    v_reset_at as reset_at,
    v_current_count::integer as current_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
