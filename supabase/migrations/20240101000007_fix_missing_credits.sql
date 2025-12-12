-- ============================================
-- FUNCTION: Fix Missing Credits for Completed Payments
-- ============================================
-- This function retroactively processes payments that were completed
-- but credits weren't added. It reads credits from metadata or payment amount.
CREATE OR REPLACE FUNCTION public.fix_missing_credits_for_payments()
RETURNS TABLE (
  payment_id uuid,
  user_id uuid,
  credits_added integer,
  success boolean,
  error_message text
) AS $$
DECLARE
  payment_record RECORD;
  credits_to_add integer;
  current_credits integer;
BEGIN
  -- Process all completed credit payments where credits = 0 or NULL
  FOR payment_record IN
    SELECT
      sp.id,
      sp.user_id,
      sp.amount,
      sp.metadata,
      sp.stripe_session_id
    FROM public.stripe_payments sp
    WHERE sp.status = 'completed'
      AND sp.type = 'credits'
      AND (sp.credits IS NULL OR sp.credits = 0)
    ORDER BY sp.created_at DESC
  LOOP
    BEGIN
      -- Try to get credits from metadata
      credits_to_add := NULL;

      IF payment_record.metadata->>'credits' IS NOT NULL THEN
        credits_to_add := (payment_record.metadata->>'credits')::integer;
      ELSE
        -- Fallback: infer from amount
        -- Rough mapping: $5 = 10 credits, $10 = 25 credits, $20 = 60 credits
        DECLARE
          amount_dollars numeric;
        BEGIN
          amount_dollars := payment_record.amount / 100.0;
          IF amount_dollars >= 19 THEN
            credits_to_add := 60;
          ELSIF amount_dollars >= 9 THEN
            credits_to_add := 25;
          ELSIF amount_dollars >= 4 THEN
            credits_to_add := 10;
          END IF;
        END;
      END IF;

      -- If we found credits to add, add them
      IF credits_to_add IS NOT NULL AND credits_to_add > 0 THEN
        -- Get current credits
        SELECT credits INTO current_credits
        FROM public.users_profile
        WHERE id = payment_record.user_id;

        -- Increment credits
        PERFORM public.increment_credits(
          payment_record.user_id,
          credits_to_add
        );

        -- Update payment record with credits
        UPDATE public.stripe_payments
        SET credits = credits_to_add
        WHERE id = payment_record.id;

        -- Return success
        payment_id := payment_record.id;
        user_id := payment_record.user_id;
        credits_added := credits_to_add;
        success := true;
        error_message := NULL;
        RETURN NEXT;
      ELSE
        -- Could not determine credits
        payment_id := payment_record.id;
        user_id := payment_record.user_id;
        credits_added := 0;
        success := false;
        error_message := 'Could not determine credits from metadata or amount';
        RETURN NEXT;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        -- Return error
        payment_id := payment_record.id;
        user_id := payment_record.user_id;
        credits_added := 0;
        success := false;
        error_message := SQLERRM;
        RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- FUNCTION: Fix Missing Credits for Single Payment
-- ============================================
-- Helper function to fix credits for a specific payment by session_id
CREATE OR REPLACE FUNCTION public.fix_missing_credits_for_payment(
  p_session_id text,
  p_credits integer DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  payment_record RECORD;
  credits_to_add integer;
  current_credits integer;
BEGIN
  -- Find the payment
  SELECT
    sp.id,
    sp.user_id,
    sp.amount,
    sp.metadata,
    sp.credits
  INTO payment_record
  FROM public.stripe_payments sp
  WHERE sp.stripe_session_id = p_session_id
    AND sp.status = 'completed'
    AND sp.type = 'credits'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Payment not found or not a completed credit payment'
    );
  END IF;

  -- Use provided credits or try to determine from metadata/amount
  IF p_credits IS NOT NULL AND p_credits > 0 THEN
    credits_to_add := p_credits;
  ELSIF payment_record.metadata->>'credits' IS NOT NULL THEN
    credits_to_add := (payment_record.metadata->>'credits')::integer;
  ELSE
    -- Fallback: infer from amount
    DECLARE
      amount_dollars numeric;
    BEGIN
      amount_dollars := payment_record.amount / 100.0;
      IF amount_dollars >= 19 THEN
        credits_to_add := 60;
      ELSIF amount_dollars >= 9 THEN
        credits_to_add := 25;
      ELSIF amount_dollars >= 4 THEN
        credits_to_add := 10;
      ELSE
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Could not determine credits from amount'
        );
      END IF;
    END;
  END IF;

  -- Check if credits were already added
  IF payment_record.credits IS NOT NULL AND payment_record.credits > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', format('Credits already added: %s', payment_record.credits),
      'credits', payment_record.credits
    );
  END IF;

  -- Get current credits
  SELECT credits INTO current_credits
  FROM public.users_profile
  WHERE id = payment_record.user_id;

  -- Increment credits
  PERFORM public.increment_credits(
    payment_record.user_id,
    credits_to_add
  );

  -- Update payment record with credits
  UPDATE public.stripe_payments
  SET credits = credits_to_add
  WHERE id = payment_record.id;

  RETURN jsonb_build_object(
    'success', true,
    'payment_id', payment_record.id,
    'user_id', payment_record.user_id,
    'credits_added', credits_to_add,
    'previous_credits', COALESCE(current_credits, 0),
    'new_credits', COALESCE(current_credits, 0) + credits_to_add
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


