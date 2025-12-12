-- ============================================
-- USER QUOTA SYSTEM
-- ============================================
-- Implements freemium quota system with daily creation limits
-- and lifetime save slots, with pack purchases and pro subscriptions

-- ============================================
-- TABLE: user_quota
-- ============================================
CREATE TABLE public.user_quota (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  save_slots_remaining integer NOT NULL DEFAULT 10 CHECK (save_slots_remaining >= 0),
  creations_remaining_today integer NOT NULL DEFAULT 10 CHECK (creations_remaining_today >= 0),
  bonus_creations_remaining integer NOT NULL DEFAULT 0 CHECK (bonus_creations_remaining >= 0),
  last_creation_reset timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_quota_last_reset ON public.user_quota (last_creation_reset);

-- ============================================
-- TABLE: packs
-- ============================================
CREATE TABLE public.packs (
  sku text PRIMARY KEY,
  adds_creations integer NOT NULL CHECK (adds_creations > 0),
  adds_saves integer NOT NULL CHECK (adds_saves > 0),
  price_cents integer,
  display_name text NOT NULL,
  stripe_price_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed pack data (matches existing Stripe product keys)
INSERT INTO public.packs (sku, adds_creations, adds_saves, display_name, active) VALUES
  ('credits_10', 10, 10, 'Starter Pack', true),
  ('credits_25', 25, 25, 'Popular Pack', true),
  ('credits_60', 60, 60, 'Value Pack', true)
ON CONFLICT (sku) DO NOTHING;

-- ============================================
-- TABLE: purchases
-- ============================================
CREATE TABLE public.purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sku text NOT NULL REFERENCES public.packs(sku),
  amount_cents integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'refunded')) DEFAULT 'pending',
  idempotency_key text UNIQUE NOT NULL,
  stripe_session_id text UNIQUE,
  stripe_payment_intent_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_purchases_user_id ON public.purchases (user_id);
CREATE INDEX idx_purchases_status ON public.purchases (status);
CREATE INDEX idx_purchases_idempotency_key ON public.purchases (idempotency_key);
CREATE INDEX idx_purchases_stripe_session_id ON public.purchases (stripe_session_id) WHERE stripe_session_id IS NOT NULL;

-- ============================================
-- FUNCTION: Get/Initialize User Quota
-- ============================================
CREATE OR REPLACE FUNCTION public.get_user_quota(p_user_id uuid)
RETURNS TABLE (
  save_slots_remaining integer,
  creations_remaining_today integer,
  bonus_creations_remaining integer,
  last_creation_reset timestamptz,
  is_pro boolean
) AS $$
DECLARE
  v_plan text;
  v_quota_exists boolean;
  v_now timestamptz := now();
  v_reset_date date;
  v_last_reset_date date;
BEGIN
  -- Get user plan
  SELECT plan INTO v_plan
  FROM public.users_profile
  WHERE id = p_user_id;

  -- Check if quota exists
  SELECT EXISTS(SELECT 1 FROM public.user_quota WHERE user_id = p_user_id) INTO v_quota_exists;

  -- Initialize quota if missing
  IF NOT v_quota_exists THEN
    INSERT INTO public.user_quota (
      user_id,
      save_slots_remaining,
      creations_remaining_today,
      bonus_creations_remaining,
      last_creation_reset
    ) VALUES (
      p_user_id,
      10,
      10,
      0,
      v_now
    );
  END IF;

  -- Check if daily reset is needed (reset at midnight UTC)
  SELECT DATE(last_creation_reset AT TIME ZONE 'UTC') INTO v_last_reset_date
  FROM public.user_quota
  WHERE user_id = p_user_id;

  SELECT CURRENT_DATE INTO v_reset_date;

  -- Reset daily creations if needed
  IF v_last_reset_date < v_reset_date THEN
    UPDATE public.user_quota
    SET
      creations_remaining_today = 10,
      last_creation_reset = v_now
    WHERE user_id = p_user_id;
  END IF;

  -- Return quota info
  RETURN QUERY
  SELECT
    uq.save_slots_remaining,
    uq.creations_remaining_today,
    uq.bonus_creations_remaining,
    uq.last_creation_reset,
    (v_plan = 'pro')::boolean as is_pro
  FROM public.user_quota uq
  WHERE uq.user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Atomic Decrement Creation Quota
-- ============================================
CREATE OR REPLACE FUNCTION public.decrement_creation_quota(
  p_user_id uuid,
  p_amount integer DEFAULT 1
)
RETURNS boolean AS $$
DECLARE
  v_plan text;
  v_bonus integer;
  v_daily integer;
  v_total integer;
BEGIN
  -- Check if user is pro
  SELECT plan INTO v_plan
  FROM public.users_profile
  WHERE id = p_user_id;

  IF v_plan = 'pro' THEN
    RETURN true; -- Pro users have unlimited quota
  END IF;

  -- Ensure quota exists
  PERFORM public.get_user_quota(p_user_id);

  -- Get current quota with row lock
  SELECT bonus_creations_remaining, creations_remaining_today
  INTO v_bonus, v_daily
  FROM public.user_quota
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_total := COALESCE(v_bonus, 0) + COALESCE(v_daily, 0);

  -- Check if sufficient quota
  IF v_total < p_amount THEN
    RETURN false;
  END IF;

  -- Use bonus first, then daily
  IF v_bonus >= p_amount THEN
    -- Use only bonus
    UPDATE public.user_quota
    SET
      bonus_creations_remaining = bonus_creations_remaining - p_amount,
      updated_at = now()
    WHERE user_id = p_user_id;
  ELSIF v_bonus > 0 THEN
    -- Use all bonus and some daily
    UPDATE public.user_quota
    SET
      bonus_creations_remaining = 0,
      creations_remaining_today = creations_remaining_today - (p_amount - v_bonus),
      updated_at = now()
    WHERE user_id = p_user_id;
  ELSE
    -- Use only daily
    UPDATE public.user_quota
    SET
      creations_remaining_today = creations_remaining_today - p_amount,
      updated_at = now()
    WHERE user_id = p_user_id;
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Atomic Decrement Save Slots
-- ============================================
CREATE OR REPLACE FUNCTION public.decrement_save_slots(
  p_user_id uuid,
  p_amount integer DEFAULT 1
)
RETURNS boolean AS $$
DECLARE
  v_plan text;
  v_slots integer;
BEGIN
  -- Check if user is pro
  SELECT plan INTO v_plan
  FROM public.users_profile
  WHERE id = p_user_id;

  IF v_plan = 'pro' THEN
    RETURN true; -- Pro users have unlimited slots
  END IF;

  -- Ensure quota exists
  PERFORM public.get_user_quota(p_user_id);

  -- Get current slots with row lock
  SELECT save_slots_remaining INTO v_slots
  FROM public.user_quota
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Check if sufficient slots
  IF v_slots < p_amount THEN
    RETURN false;
  END IF;

  -- Decrement slots
  UPDATE public.user_quota
  SET
    save_slots_remaining = save_slots_remaining - p_amount,
    updated_at = now()
  WHERE user_id = p_user_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Apply Pack Credits (Atomic)
-- ============================================
CREATE OR REPLACE FUNCTION public.apply_pack_credits(
  p_user_id uuid,
  p_sku text,
  p_idempotency_key text
)
RETURNS jsonb AS $$
DECLARE
  v_pack RECORD;
  v_existing_purchase RECORD;
  v_result jsonb;
BEGIN
  -- Check if purchase already processed
  SELECT * INTO v_existing_purchase
  FROM public.purchases
  WHERE idempotency_key = p_idempotency_key;

  IF v_existing_purchase IS NOT NULL THEN
    IF v_existing_purchase.status = 'completed' THEN
      RETURN jsonb_build_object(
        'success', true,
        'message', 'Purchase already processed',
        'purchase_id', v_existing_purchase.id
      );
    END IF;
  END IF;

  -- Get pack details
  SELECT * INTO v_pack
  FROM public.packs
  WHERE sku = p_sku AND active = true;

  IF v_pack IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Pack not found or inactive'
    );
  END IF;

  -- Ensure quota exists
  PERFORM public.get_user_quota(p_user_id);

  -- Atomically increment quota with row lock
  UPDATE public.user_quota
  SET
    bonus_creations_remaining = bonus_creations_remaining + v_pack.adds_creations,
    save_slots_remaining = save_slots_remaining + v_pack.adds_saves,
    updated_at = now()
  WHERE user_id = p_user_id;

  -- Update or create purchase record
  IF v_existing_purchase IS NOT NULL THEN
    UPDATE public.purchases
    SET
      status = 'completed',
      updated_at = now()
    WHERE idempotency_key = p_idempotency_key;
  ELSE
    INSERT INTO public.purchases (
      user_id,
      sku,
      amount_cents,
      status,
      idempotency_key
    ) VALUES (
      p_user_id,
      p_sku,
      COALESCE(v_pack.price_cents, 0),
      'completed',
      p_idempotency_key
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'creations_added', v_pack.adds_creations,
    'saves_added', v_pack.adds_saves
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Check Purchase Idempotency
-- ============================================
CREATE OR REPLACE FUNCTION public.check_purchase_idempotency(
  p_idempotency_key text
)
RETURNS jsonb AS $$
DECLARE
  v_purchase RECORD;
BEGIN
  SELECT * INTO v_purchase
  FROM public.purchases
  WHERE idempotency_key = p_idempotency_key;

  IF v_purchase IS NULL THEN
    RETURN NULL::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'id', v_purchase.id,
    'user_id', v_purchase.user_id,
    'sku', v_purchase.sku,
    'status', v_purchase.status,
    'created_at', v_purchase.created_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- TRIGGER: Auto-initialize user_quota on profile creation
-- ============================================
CREATE OR REPLACE FUNCTION public.handle_new_user_quota()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.user_quota (
    user_id,
    save_slots_remaining,
    creations_remaining_today,
    bonus_creations_remaining,
    last_creation_reset
  ) VALUES (
    NEW.id,
    10,
    10,
    0,
    now()
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_users_profile_created_quota
  AFTER INSERT ON public.users_profile
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_quota();

-- ============================================
-- TRIGGER: Update updated_at on user_quota
-- ============================================
CREATE TRIGGER update_user_quota_updated_at
  BEFORE UPDATE ON public.user_quota
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- TRIGGER: Update updated_at on packs
-- ============================================
CREATE TRIGGER update_packs_updated_at
  BEFORE UPDATE ON public.packs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- TRIGGER: Update updated_at on purchases
-- ============================================
CREATE TRIGGER update_purchases_updated_at
  BEFORE UPDATE ON public.purchases
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- RLS POLICIES
-- ============================================

-- Enable RLS
ALTER TABLE public.user_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;

-- user_quota: Users can SELECT their own quota
CREATE POLICY "user_quota_select_own" ON public.user_quota
  FOR SELECT
  USING (auth.uid() = user_id);

-- packs: Public SELECT (for pack listing)
CREATE POLICY "packs_select_public" ON public.packs
  FOR SELECT
  USING (active = true);

-- purchases: Users can SELECT their own purchases
CREATE POLICY "purchases_select_own" ON public.purchases
  FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can manage all tables (via Edge Functions)
-- Note: Edge Functions use service role, bypassing RLS
