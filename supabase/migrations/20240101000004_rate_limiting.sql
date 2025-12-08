-- ============================================
-- RATE LIMITING TABLE
-- ============================================
-- Tracks rate limit requests by identifier (IP or user_id) and endpoint
CREATE TABLE public.rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL, -- IP address or user_id
  endpoint text NOT NULL, -- 'analyze-image', 'view-increment', etc.
  window_start timestamptz NOT NULL, -- Start of the time window
  request_count integer DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(identifier, endpoint, window_start)
);

-- Indexes for efficient lookups
CREATE INDEX idx_rate_limits_identifier_endpoint ON public.rate_limits (identifier, endpoint);
CREATE INDEX idx_rate_limits_window_start ON public.rate_limits (window_start);

-- ============================================
-- FUNCTION: Check and Update Rate Limit
-- ============================================
-- Checks if a request is allowed based on rate limits
-- Returns: allowed (boolean), remaining (integer), reset_at (timestamptz)
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

  -- Get or create rate limit record
  INSERT INTO public.rate_limits (identifier, endpoint, window_start, request_count)
  VALUES (p_identifier, p_endpoint, v_window_start, 1)
  ON CONFLICT (identifier, endpoint, window_start)
  DO UPDATE SET
    request_count = public.rate_limits.request_count + 1,
    updated_at = NOW()
  RETURNING request_count INTO v_current_count;

  -- If record already existed, get the updated count
  IF v_current_count IS NULL THEN
    SELECT request_count INTO v_current_count
    FROM public.rate_limits
    WHERE identifier = p_identifier
      AND endpoint = p_endpoint
      AND window_start = v_window_start;
  END IF;

  -- Check if limit is exceeded
  RETURN QUERY SELECT
    (v_current_count <= p_limit) as allowed,
    GREATEST(0, p_limit - v_current_count)::integer as remaining,
    v_reset_at as reset_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Clean Old Rate Limit Records
-- ============================================
-- Removes rate limit records older than 24 hours
-- Can be called periodically via cron job
CREATE OR REPLACE FUNCTION public.clean_old_rate_limits()
RETURNS integer AS $$
DECLARE
  v_deleted_count integer;
BEGIN
  DELETE FROM public.rate_limits
  WHERE window_start < NOW() - INTERVAL '24 hours';

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- RLS POLICIES FOR RATE_LIMITS
-- ============================================
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (for Edge Functions)
CREATE POLICY "rate_limits_service_role_all" ON public.rate_limits
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================
-- FUNCTION: Check View Increment Rate Limit
-- ============================================
-- Checks if a view increment is allowed (1 per IP per hour per listing)
-- Returns true if view should be counted, false if rate limited
CREATE OR REPLACE FUNCTION public.check_view_increment_rate_limit(
  p_listing_id uuid,
  p_viewer_ip inet
)
RETURNS boolean AS $$
DECLARE
  v_recent_view_exists boolean;
BEGIN
  -- Check if there's a view from this IP in the last hour for this listing
  SELECT EXISTS(
    SELECT 1
    FROM public.listing_views
    WHERE listing_id = p_listing_id
      AND viewer_ip = p_viewer_ip
      AND created_at >= NOW() - INTERVAL '1 hour'
  ) INTO v_recent_view_exists;

  -- Return true if no recent view (allow increment), false if recent view exists (rate limited)
  RETURN NOT v_recent_view_exists;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
