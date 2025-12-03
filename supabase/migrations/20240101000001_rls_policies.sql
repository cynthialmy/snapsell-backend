-- Enable Row Level Security on all tables
ALTER TABLE public.users_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- ============================================
-- USERS_PROFILE POLICIES
-- ============================================

-- Users can read their own profile
CREATE POLICY "users_profile_select_own" ON public.users_profile
  FOR SELECT
  USING (auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "users_profile_update_own" ON public.users_profile
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Profile creation is handled by trigger, but allow insert for authenticated users
CREATE POLICY "users_profile_insert_own" ON public.users_profile
  FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ============================================
-- LISTINGS POLICIES
-- ============================================

-- Users can insert their own listings
CREATE POLICY "listings_insert_own" ON public.listings
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own listings
CREATE POLICY "listings_update_own" ON public.listings
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own listings
CREATE POLICY "listings_delete_own" ON public.listings
  FOR DELETE
  USING (auth.uid() = user_id);

-- Users can select their own listings OR public/shared listings
-- Note: Share slug access is handled via Edge Function, but this allows direct queries
CREATE POLICY "listings_select_own_or_public" ON public.listings
  FOR SELECT
  USING (
    auth.uid() = user_id OR
    visibility IN ('shared', 'public')
  );

-- ============================================
-- LISTING_VIEWS POLICIES
-- ============================================

-- Anyone can insert a view (for tracking public shares)
CREATE POLICY "listing_views_insert_any" ON public.listing_views
  FOR INSERT
  WITH CHECK (true);

-- Users can read views for their own listings
CREATE POLICY "listing_views_select_own_listings" ON public.listing_views
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.listings
      WHERE listings.id = listing_views.listing_id
      AND listings.user_id = auth.uid()
    )
  );

-- ============================================
-- FEEDBACK POLICIES
-- ============================================

-- Authenticated users can insert feedback (user_id will be set)
-- Anonymous users can also insert (user_id will be null)
CREATE POLICY "feedback_insert_any" ON public.feedback
  FOR INSERT
  WITH CHECK (
    user_id IS NULL OR
    auth.uid() = user_id
  );

-- Users can read their own feedback
CREATE POLICY "feedback_select_own" ON public.feedback
  FOR SELECT
  USING (
    user_id IS NULL OR
    auth.uid() = user_id
  );

-- Users can update their own feedback
CREATE POLICY "feedback_update_own" ON public.feedback
  FOR UPDATE
  USING (
    user_id IS NOT NULL AND
    auth.uid() = user_id
  )
  WITH CHECK (
    user_id IS NOT NULL AND
    auth.uid() = user_id
  );

-- ============================================
-- USAGE_LOGS POLICIES
-- ============================================

-- System can insert usage logs (via Edge Functions with service role)
-- Users can insert their own logs
CREATE POLICY "usage_logs_insert_own" ON public.usage_logs
  FOR INSERT
  WITH CHECK (
    user_id IS NULL OR
    auth.uid() = user_id
  );

-- Users can read their own usage logs
CREATE POLICY "usage_logs_select_own" ON public.usage_logs
  FOR SELECT
  USING (
    user_id IS NULL OR
    auth.uid() = user_id
  );

-- ============================================
-- SUBSCRIPTIONS POLICIES
-- ============================================

-- Users can read their own subscriptions
CREATE POLICY "subscriptions_select_own" ON public.subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);

-- Insert/update handled by Edge Functions with service role
-- Users cannot directly modify subscriptions
