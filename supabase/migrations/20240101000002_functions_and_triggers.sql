-- ============================================
-- FUNCTION: Check Free Quota
-- ============================================
-- Counts listings created by user in the last 30 days
CREATE OR REPLACE FUNCTION public.check_free_quota(
  p_user_id uuid,
  p_free_limit integer DEFAULT 10
)
RETURNS TABLE (
  used_count integer,
  limit_count integer,
  remaining_count integer,
  has_quota boolean
) AS $$
DECLARE
  v_used integer;
  v_plan text;
  v_credits integer;
BEGIN
  -- Get user's plan and credits
  SELECT plan, credits INTO v_plan, v_credits
  FROM public.users_profile
  WHERE id = p_user_id;

  -- Pro users have unlimited quota
  IF v_plan = 'pro' THEN
    RETURN QUERY SELECT
      0::integer as used_count,
      999999::integer as limit_count,
      999999::integer as remaining_count,
      true as has_quota;
    RETURN;
  END IF;

  -- Count listings in last 30 days
  SELECT COUNT(*)::integer INTO v_used
  FROM public.listings
  WHERE user_id = p_user_id
    AND created_at >= NOW() - INTERVAL '30 days';

  -- Calculate remaining
  RETURN QUERY SELECT
    v_used as used_count,
    p_free_limit as limit_count,
    GREATEST(0, p_free_limit - v_used)::integer as remaining_count,
    (v_used < p_free_limit OR v_credits > 0) as has_quota;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Generate Unique Share Slug
-- ============================================
CREATE OR REPLACE FUNCTION public.generate_share_slug()
RETURNS text AS $$
DECLARE
  v_slug text;
  v_exists boolean;
BEGIN
  LOOP
    -- Generate a random 12-character slug
    v_slug := lower(
      substring(
        encode(gen_random_bytes(9), 'base64')
        from 1 for 12
      )
    );
    -- Replace URL-unsafe characters
    v_slug := replace(replace(replace(v_slug, '/', 'a'), '+', 'b'), '=', 'c');

    -- Check if slug exists
    SELECT EXISTS(
      SELECT 1 FROM public.listings WHERE share_slug = v_slug
    ) INTO v_exists;

    -- Exit loop if slug is unique
    EXIT WHEN NOT v_exists;
  END LOOP;

  RETURN v_slug;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- FUNCTION: Increment Listing Views
-- ============================================
CREATE OR REPLACE FUNCTION public.increment_listing_view(
  p_listing_id uuid,
  p_viewer_ip inet DEFAULT NULL,
  p_viewer_user_id uuid DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  INSERT INTO public.listing_views (
    listing_id,
    viewer_ip,
    viewer_user_id,
    created_at
  ) VALUES (
    p_listing_id,
    p_viewer_ip,
    p_viewer_user_id,
    NOW()
  );
EXCEPTION
  WHEN OTHERS THEN
    -- Silently fail if there's an error (e.g., duplicate key)
    NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Increment Credits (for Stripe webhook)
-- ============================================
CREATE OR REPLACE FUNCTION public.increment_credits(
  p_user_id uuid,
  p_amount integer DEFAULT 1
)
RETURNS void AS $$
BEGIN
  UPDATE public.users_profile
  SET credits = credits + p_amount
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- TRIGGER: Auto-update updated_at on listings
-- ============================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_listings_updated_at
  BEFORE UPDATE ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- TRIGGER: Auto-update updated_at on subscriptions
-- ============================================
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- FUNCTION: Deduct Credit (for use in Edge Functions)
-- ============================================
CREATE OR REPLACE FUNCTION public.deduct_credit(
  p_user_id uuid,
  p_amount integer DEFAULT 1
)
RETURNS boolean AS $$
DECLARE
  v_current_credits integer;
BEGIN
  -- Get current credits
  SELECT credits INTO v_current_credits
  FROM public.users_profile
  WHERE id = p_user_id;

  -- Check if user has enough credits
  IF v_current_credits < p_amount THEN
    RETURN false;
  END IF;

  -- Deduct credits
  UPDATE public.users_profile
  SET credits = credits - p_amount
  WHERE id = p_user_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
