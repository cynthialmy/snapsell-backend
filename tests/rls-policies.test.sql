-- RLS Policy Tests
-- These SQL statements can be run to verify RLS policies are working correctly
-- Run these in your Supabase SQL editor or via psql

-- ============================================
-- Test Setup: Create test users
-- ============================================

-- Note: In a real test environment, you would create test users via Supabase Auth API
-- These are example queries to verify RLS policies

-- ============================================
-- Test 1: Users can only read their own profile
-- ============================================

-- As user1, try to read user2's profile (should fail)
-- SELECT * FROM users_profile WHERE id = 'user2-uuid';
-- Expected: No rows returned (RLS blocks access)

-- As user1, read own profile (should succeed)
-- SELECT * FROM users_profile WHERE id = auth.uid();
-- Expected: Returns user1's profile

-- ============================================
-- Test 2: Users can only CRUD their own listings
-- ============================================

-- As user1, try to insert listing for user2 (should fail)
-- INSERT INTO listings (user_id, title, description, storage_path)
-- VALUES ('user2-uuid', 'Test', 'Test description', 'path/to/image');
-- Expected: Error - RLS policy blocks insert

-- As user1, insert own listing (should succeed)
-- INSERT INTO listings (user_id, title, description, storage_path)
-- VALUES (auth.uid(), 'My Listing', 'My description', 'path/to/image');
-- Expected: Success

-- As user1, try to update user2's listing (should fail)
-- UPDATE listings SET title = 'Hacked' WHERE user_id = 'user2-uuid';
-- Expected: No rows updated (RLS blocks update)

-- As user1, try to delete user2's listing (should fail)
-- DELETE FROM listings WHERE user_id = 'user2-uuid';
-- Expected: No rows deleted (RLS blocks delete)

-- ============================================
-- Test 3: Public/shared listings are readable
-- ============================================

-- Create a shared listing as user1
-- INSERT INTO listings (user_id, title, description, storage_path, visibility, share_slug)
-- VALUES (auth.uid(), 'Shared Listing', 'Description', 'path/to/image', 'shared', 'test-slug-123');

-- As user2 (or anonymous), try to read shared listing
-- SELECT * FROM listings WHERE share_slug = 'test-slug-123';
-- Expected: Returns the listing (RLS allows read for shared/public)

-- As user2, try to read user1's private listing (should fail)
-- SELECT * FROM listings WHERE user_id = 'user1-uuid' AND visibility = 'private';
-- Expected: No rows returned (RLS blocks access)

-- ============================================
-- Test 4: Feedback policies
-- ============================================

-- As user1, insert feedback (should succeed)
-- INSERT INTO feedback (user_id, type, comment)
-- VALUES (auth.uid(), 'app', 'Great app!');
-- Expected: Success

-- As user1, try to read user2's feedback (should fail)
-- SELECT * FROM feedback WHERE user_id = 'user2-uuid';
-- Expected: No rows returned (RLS blocks access)

-- Anonymous feedback insert (should succeed if policy allows)
-- INSERT INTO feedback (type, comment) VALUES ('app', 'Anonymous feedback');
-- Expected: Success (if policy allows null user_id)

-- ============================================
-- Test 5: Usage logs policies
-- ============================================

-- As user1, insert own usage log (should succeed)
-- INSERT INTO usage_logs (user_id, action)
-- VALUES (auth.uid(), 'create_listing');
-- Expected: Success

-- As user1, try to read user2's usage logs (should fail)
-- SELECT * FROM usage_logs WHERE user_id = 'user2-uuid';
-- Expected: No rows returned (RLS blocks access)

-- ============================================
-- Test 6: Subscriptions policies
-- ============================================

-- As user1, try to read user2's subscription (should fail)
-- SELECT * FROM subscriptions WHERE user_id = 'user2-uuid';
-- Expected: No rows returned (RLS blocks access)

-- As user1, read own subscription (should succeed)
-- SELECT * FROM subscriptions WHERE user_id = auth.uid();
-- Expected: Returns user1's subscription if exists

-- ============================================
-- Verification Queries
-- ============================================

-- Check that RLS is enabled on all tables
SELECT
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('users_profile', 'listings', 'listing_views', 'feedback', 'usage_logs', 'subscriptions')
ORDER BY tablename;

-- Expected: All tables should have rowsecurity = true

-- List all RLS policies
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- Expected: Should see policies for all tables
