-- ============================================
-- CASCADE DELETE: Remove auth.users when users_profile is deleted
-- ============================================
-- This migration ensures that when a user is deleted from users_profile,
-- they are also removed from auth.users (Supabase Authentication).
--
-- IMPORTANT: This uses a database trigger that directly deletes from auth.users.
-- This requires SECURITY DEFINER privileges and may need to be enabled in Supabase.
-- If direct deletion doesn't work, you may need to use an Edge Function approach instead.

-- ============================================
-- FUNCTION: Delete auth user when profile is deleted
-- ============================================
-- This function is called by a trigger when a row is deleted from users_profile.
-- It attempts to delete the corresponding user from auth.users.
CREATE OR REPLACE FUNCTION public.delete_auth_user_on_profile_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Attempt to delete from auth.users directly
  -- This requires SECURITY DEFINER and appropriate database permissions
  DELETE FROM auth.users WHERE id = OLD.id;

  -- Log successful deletion
  RAISE NOTICE 'Deleted auth user % when profile was deleted', OLD.id;

  RETURN OLD;
EXCEPTION
  WHEN insufficient_privilege OR undefined_table THEN
    -- If direct deletion fails (e.g., insufficient privileges or auth.users not accessible),
    -- log a warning but don't fail the transaction
    -- The user will need to be deleted manually from Supabase Dashboard or via Edge Function
    RAISE WARNING 'Could not delete auth user % automatically. User may still exist in auth.users. Error: %', OLD.id, SQLERRM;
    RETURN OLD;
  WHEN OTHERS THEN
    -- For any other error, log it but don't fail the transaction
    RAISE WARNING 'Error deleting auth user %: %', OLD.id, SQLERRM;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- TRIGGER: Delete auth user when profile is deleted
-- ============================================
CREATE TRIGGER on_users_profile_deleted
  AFTER DELETE ON public.users_profile
  FOR EACH ROW
  EXECUTE FUNCTION public.delete_auth_user_on_profile_delete();

-- ============================================
-- NOTES:
-- ============================================
-- 1. This trigger fires AFTER DELETE, so the users_profile row is already deleted
-- 2. If direct deletion from auth.users doesn't work, you may need to:
--    a. Enable the necessary permissions in Supabase Dashboard
--    b. Use an alternative approach with pg_net extension to call the delete-auth-user-internal Edge Function
--    c. Manually delete users from Supabase Dashboard when needed
-- 3. The function uses SECURITY DEFINER to run with elevated privileges
-- 4. Errors are logged but don't fail the transaction to prevent data inconsistency
-- 5. An alternative Edge Function (delete-auth-user-internal) is available if pg_net approach is needed
--
-- ALTERNATIVE APPROACH (if direct deletion doesn't work):
-- If you need to use pg_net to call the Edge Function instead, you can modify the function to:
-- 1. Enable pg_net extension: CREATE EXTENSION IF NOT EXISTS pg_net;
-- 2. Use net.http_post() to call: {SUPABASE_URL}/functions/v1/delete-auth-user-internal
-- 3. Pass the service role key in the Authorization header
-- Note: This requires storing the Supabase URL and service role key securely (e.g., in Vault)


