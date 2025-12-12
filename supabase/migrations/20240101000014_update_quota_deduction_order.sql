-- ============================================
-- UPDATE: Change quota deduction order
-- ============================================
-- Update decrement_creation_quota to deduct free quota (daily) first,
-- then purchased quota (bonus), preserving purchased credits for when free quota runs out

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

  -- Use daily (free) quota first, then bonus (purchased) quota
  IF v_daily >= p_amount THEN
    -- Use only daily
    UPDATE public.user_quota
    SET
      creations_remaining_today = creations_remaining_today - p_amount,
      updated_at = now()
    WHERE user_id = p_user_id;
  ELSIF v_daily > 0 THEN
    -- Use all daily and some bonus
    UPDATE public.user_quota
    SET
      creations_remaining_today = 0,
      bonus_creations_remaining = bonus_creations_remaining - (p_amount - v_daily),
      updated_at = now()
    WHERE user_id = p_user_id;
  ELSE
    -- Use only bonus
    UPDATE public.user_quota
    SET
      bonus_creations_remaining = bonus_creations_remaining - p_amount,
      updated_at = now()
    WHERE user_id = p_user_id;
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
