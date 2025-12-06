# Edge Functions Fix Guide

## Issues Identified

1. **`/upload` Edge Function failing** - Returns non-200 status
2. **`/usage-check-quota` Edge Function returning 500** - Internal server error

## Root Causes

The most likely causes are:
1. **Functions not deployed** to Supabase
2. **Database function missing** - `check_free_quota` not created (migrations not applied)
3. **Storage bucket missing** - `items` bucket not created or misconfigured
4. **Environment variables** - Though Supabase keys are auto-provided, there might be configuration issues

## What I've Done

### 1. Enhanced Error Messages
- Added detailed error logging to both `upload` and `usage-check-quota` functions
- Error messages now include diagnostic information (which env vars are missing, etc.)
- Added helpful hints in error responses (e.g., "Bucket may not exist", "Database function may not exist")

### 2. Created Diagnostic Tools
- **`tools/diagnose-edge-functions.sh`** - Comprehensive diagnostic script that:
  - Checks if functions are deployed
  - Shows recent logs
  - Lists configured secrets
  - Provides recommendations

- **`tools/fix-edge-functions.sh`** - Automated fix script that:
  - Deploys both `upload` and `usage-check-quota` functions
  - Provides instructions for database migrations
  - Guides storage bucket setup

### 3. Updated Documentation
- Added troubleshooting section to `README.md` with specific fixes for these issues
- Documented common error messages and their solutions

## Next Steps - Fix the Issues

### Step 1: Run Diagnostics

```bash
cd /Users/MLI114/Projects/snapsell-backend
./tools/diagnose-edge-functions.sh
```

This will show you:
- Which functions are deployed
- Recent error logs
- Missing configuration

### Step 2: Deploy Functions

**Option A: Use the fix script (recommended)**
```bash
./tools/fix-edge-functions.sh
```

**Option B: Deploy manually**
```bash
supabase functions deploy upload
supabase functions deploy usage-check-quota
```

### Step 3: Verify Database Migrations

The `usage-check-quota` function requires the `check_free_quota` database function:

```bash
# Apply all migrations
supabase db push
```

Or verify in Supabase Dashboard → SQL Editor:
```sql
SELECT proname FROM pg_proc WHERE proname = 'check_free_quota';
```

If it returns no rows, run the migrations.

### Step 4: Verify Storage Bucket

1. Go to **Supabase Dashboard** → **Storage**
2. Check if `items` bucket exists
3. If not, create it with:
   - **Name:** `items`
   - **Public:** No (private)
   - **File size limit:** 10MB
   - **Allowed MIME types:** `image/jpeg`, `image/jpg`, `image/png`, `image/webp`

### Step 5: Test the Functions

After deploying, test from your app or using curl:

```bash
# Test upload (requires auth token)
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"file": "data:image/jpeg;base64,...", "contentType": "image/jpeg"}'

# Test quota check (requires auth token)
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/usage-check-quota \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Common Error Messages & Fixes

### "Server configuration error" / "Supabase environment variables are not available"
- **Cause:** Function not deployed or Supabase project issue
- **Fix:** Deploy the function: `supabase functions deploy <function-name>`

### "Failed to check quota" / "function check_free_quota does not exist"
- **Cause:** Database migration not applied
- **Fix:** Run `supabase db push` to apply migrations

### "Failed to upload file" / "Bucket not found"
- **Cause:** Storage bucket `items` doesn't exist
- **Fix:** Create the bucket in Supabase Dashboard → Storage

### "Unauthorized" / "Missing authorization header"
- **Cause:** Frontend not sending auth token
- **Fix:** Ensure user is authenticated and token is included in request headers

## Verification Checklist

- [ ] Functions deployed: `supabase functions list` shows `upload` and `usage-check-quota`
- [ ] Database function exists: `check_free_quota` function in database
- [ ] Storage bucket exists: `items` bucket in Supabase Dashboard
- [ ] Functions return 200: Test with authenticated requests
- [ ] Logs show no errors: `supabase functions logs <function-name>`

## Getting Help

If issues persist after following these steps:

1. **Check detailed logs:**
   ```bash
   supabase functions logs upload --limit 50
   supabase functions logs usage-check-quota --limit 50
   ```

2. **Verify Supabase project status:**
   - Check Supabase Dashboard for any service issues
   - Verify project is active and not paused

3. **Test locally (if possible):**
   ```bash
   supabase functions serve upload
   supabase functions serve usage-check-quota
   ```

4. **Review error messages:**
   - The enhanced error messages now include diagnostic information
   - Check the `debug` field in error responses for details
