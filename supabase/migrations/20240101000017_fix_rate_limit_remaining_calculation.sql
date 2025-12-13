-- ============================================
-- FIX: Rate Limit Remaining Calculation
-- ============================================
-- Fixes the issue where remaining count is calculated using old value instead of new value
-- The RETURNING clause in ON CONFLICT DO UPDATE may not always return the updated value
-- Solution: Always SELECT the count after INSERT/UPDATE to ensure we have the correct value

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_identifier text,
  p_endpoint text,
  p_limit integer,
  p_window_minutes integer
)
RETURNS TABLE (
  allowed boolean,
  remaining integer,
  reset_at timestamptz
) AS $$
DECLARE
  v_window_start timestamptz;
  v_current_count integer;
  v_reset_at timestamptz;
BEGIN
  -- Calculate window start (round down to nearest window boundary)
  v_window_start := date_trunc('minute', NOW()) -
    (EXTRACT(MINUTE FROM NOW())::integer % p_window_minutes || ' minutes')::interval;

  -- Calculate reset time (end of current window)
  v_reset_at := v_window_start + (p_window_minutes || ' minutes')::interval;

  -- Get or create rate limit record and increment
  INSERT INTO public.rate_limits (identifier, endpoint, window_start, request_count)
  VALUES (p_identifier, p_endpoint, v_window_start, 1)
  ON CONFLICT (identifier, endpoint, window_start)
  DO UPDATE SET
    request_count = public.rate_limits.request_count + 1,
    updated_at = NOW();

  -- Always SELECT the current count AFTER the INSERT/UPDATE to ensure we have the correct value
  -- This fixes the bug where RETURNING might not return the updated value
  SELECT request_count INTO v_current_count
  FROM public.rate_limits
  WHERE identifier = p_identifier
    AND endpoint = p_endpoint
    AND window_start = v_window_start;

  -- Ensure v_current_count is never NULL (defensive check)
  IF v_current_count IS NULL THEN
    v_current_count := 0;
  END IF;

  -- Check if limit is exceeded
  -- remaining should be calculated using the NEW count (after increment)
  RETURN QUERY SELECT
    (v_current_count <= p_limit) as allowed,
    GREATEST(0, p_limit - v_current_count)::integer as remaining,
    v_reset_at as reset_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
