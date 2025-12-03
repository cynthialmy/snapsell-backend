-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users Profile Table (extends auth.users)
CREATE TABLE public.users_profile (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  avatar_url text,
  created_at timestamptz DEFAULT now(),
  plan text DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'credits')),
  credits integer DEFAULT 0 CHECK (credits >= 0),
  metadata jsonb DEFAULT '{}'::jsonb
);

-- Listings Table
CREATE TABLE public.listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text,
  description text,
  price_cents integer,
  currency text DEFAULT 'USD',
  condition text,
  category text,
  tags text[],
  storage_path text,
  thumbnail_path text,
  ai_generated jsonb,
  visibility text DEFAULT 'private' CHECK (visibility IN ('private', 'shared', 'public')),
  share_slug text UNIQUE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz,
  expires_at timestamptz
);

-- Indexes for listings
CREATE INDEX idx_listings_user_id_created_at ON public.listings (user_id, created_at DESC);
CREATE INDEX idx_listings_share_slug ON public.listings (share_slug) WHERE share_slug IS NOT NULL;
CREATE INDEX idx_listings_visibility ON public.listings (visibility) WHERE visibility IN ('shared', 'public');

-- Listing Views Table (tracking)
CREATE TABLE public.listing_views (
  id serial PRIMARY KEY,
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  viewer_ip inet,
  viewer_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_listing_views_listing_id ON public.listing_views (listing_id);
CREATE INDEX idx_listing_views_created_at ON public.listing_views (created_at);

-- Feedback Table
CREATE TABLE public.feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('app', 'listing')),
  listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  rating smallint CHECK (rating >= 1 AND rating <= 5),
  comment text,
  attachment_path text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_feedback_user_id ON public.feedback (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_feedback_listing_id ON public.feedback (listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX idx_feedback_type ON public.feedback (type);

-- Usage Logs Table
CREATE TABLE public.usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('create_listing', 'share_listing', 'generate_copy', 'purchase_credits')),
  meta jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_usage_logs_user_id ON public.usage_logs (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_usage_logs_action ON public.usage_logs (action);
CREATE INDEX idx_usage_logs_created_at ON public.usage_logs (created_at);

-- Subscriptions Table (Stripe mirror)
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id text,
  stripe_subscription_id text UNIQUE,
  price_id text,
  status text NOT NULL CHECK (status IN ('active', 'trialing', 'canceled', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_subscriptions_user_id ON public.subscriptions (user_id);
CREATE INDEX idx_subscriptions_stripe_subscription_id ON public.subscriptions (stripe_subscription_id);
CREATE INDEX idx_subscriptions_status ON public.subscriptions (status);

-- Function to automatically create user profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users_profile (id, display_name, plan, credits)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email),
    'free',
    0
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create profile when user signs up
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
