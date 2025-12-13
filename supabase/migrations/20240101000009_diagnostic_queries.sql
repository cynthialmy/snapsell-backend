-- ============================================
-- Diagnostic Queries for Payment Issues
-- ============================================
-- Use these queries to diagnose payment and credit issues

-- 1. Check for payments with missing credits
SELECT
  sp.id,
  sp.user_id,
  sp.stripe_session_id,
  sp.amount,
  sp.credits,
  sp.status,
  sp.created_at,
  up.credits as user_current_credits,
  CASE
    WHEN up.id IS NULL THEN 'PROFILE_MISSING'
    WHEN sp.credits IS NULL OR sp.credits = 0 THEN 'CREDITS_MISSING'
    WHEN up.credits IS NULL THEN 'USER_CREDITS_NULL'
    ELSE 'OK'
  END as issue_type
FROM stripe_payments sp
LEFT JOIN users_profile up ON sp.user_id = up.id
WHERE sp.status = 'completed'
  AND sp.type = 'credits'
ORDER BY sp.created_at DESC;

-- 2. Check for users without profiles
SELECT
  au.id as auth_user_id,
  au.email,
  au.created_at as auth_created_at,
  up.id as profile_id,
  up.credits,
  CASE WHEN up.id IS NULL THEN 'PROFILE_MISSING' ELSE 'OK' END as status
FROM auth.users au
LEFT JOIN users_profile up ON au.id = up.id
WHERE up.id IS NULL
ORDER BY au.created_at DESC;

-- 3. Check for user_id mismatches between payments and profiles
SELECT
  sp.id as payment_id,
  sp.user_id as payment_user_id,
  sp.stripe_session_id,
  sp.status,
  up.id as profile_id,
  CASE
    WHEN up.id IS NULL THEN 'PROFILE_NOT_FOUND'
    WHEN sp.user_id != up.id THEN 'ID_MISMATCH'
    ELSE 'OK'
  END as issue
FROM stripe_payments sp
LEFT JOIN users_profile up ON sp.user_id = up.id
WHERE sp.status = 'completed'
ORDER BY sp.created_at DESC;

-- 4. Check for payments where credits weren't added
SELECT
  sp.id,
  sp.user_id,
  sp.stripe_session_id,
  sp.amount,
  sp.credits as payment_credits,
  sp.metadata->>'credits' as metadata_credits,
  up.credits as user_credits,
  sp.created_at,
  CASE
    WHEN sp.credits IS NULL OR sp.credits = 0 THEN 'NEEDS_FIX'
    WHEN up.credits IS NULL THEN 'USER_CREDITS_NULL'
    ELSE 'OK'
  END as status
FROM stripe_payments sp
LEFT JOIN users_profile up ON sp.user_id = up.id
WHERE sp.status = 'completed'
  AND sp.type = 'credits'
  AND (sp.credits IS NULL OR sp.credits = 0)
ORDER BY sp.created_at DESC;

-- 5. Summary statistics
SELECT
  COUNT(*) as total_completed_payments,
  COUNT(CASE WHEN sp.credits IS NULL OR sp.credits = 0 THEN 1 END) as payments_without_credits,
  COUNT(CASE WHEN up.id IS NULL THEN 1 END) as payments_without_profile,
  SUM(COALESCE(sp.credits, 0)) as total_credits_recorded,
  SUM(COALESCE(up.credits, 0)) as total_user_credits
FROM stripe_payments sp
LEFT JOIN users_profile up ON sp.user_id = up.id
WHERE sp.status = 'completed'
  AND sp.type = 'credits';








