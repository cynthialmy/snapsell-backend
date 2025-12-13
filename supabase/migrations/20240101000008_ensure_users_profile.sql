-- ============================================
-- FUNCTION: Ensure Users Profile Exists
-- ============================================
-- Helper function to ensure users_profile exists for a user
-- This is useful when webhooks need to update credits but profile might not exist
CREATE OR REPLACE FUNCTION public.ensure_users_profile_exists(p_user_id uuid)
RETURNS boolean AS $$
DECLARE
  profile_exists boolean;
BEGIN
  -- Check if profile exists
  SELECT EXISTS(
    SELECT 1 FROM public.users_profile WHERE id = p_user_id
  ) INTO profile_exists;

  -- If profile doesn't exist, create it
  IF NOT profile_exists THEN
    INSERT INTO public.users_profile (id, plan, credits)
    VALUES (p_user_id, 'free', 0)
    ON CONFLICT (id) DO NOTHING;
    RETURN true;
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Safe Increment Credits
-- ============================================
-- Enhanced version that ensures profile exists before incrementing
CREATE OR REPLACE FUNCTION public.safe_increment_credits(
  p_user_id uuid,
  p_amount integer DEFAULT 1
)
RETURNS jsonb AS $$
DECLARE
  profile_exists boolean;
  current_credits integer;
  new_credits integer;
BEGIN
  -- Ensure profile exists
  PERFORM public.ensure_users_profile_exists(p_user_id);

  -- Get current credits
  SELECT credits INTO current_credits
  FROM public.users_profile
  WHERE id = p_user_id;

  -- Calculate new credits
  new_credits := COALESCE(current_credits, 0) + p_amount;

  -- Update credits
  UPDATE public.users_profile
  SET credits = new_credits
  WHERE id = p_user_id;

  -- Return result
  RETURN jsonb_build_object(
    'success', true,
    'previous_credits', COALESCE(current_credits, 0),
    'added_credits', p_amount,
    'new_credits', new_credits
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;







