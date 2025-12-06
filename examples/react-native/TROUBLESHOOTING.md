# Troubleshooting Guide

Common issues and solutions when integrating SnapSell backend with your React Native app.

## Quick Fixes

### 1. "supabaseKey is required" Error

**Problem:** Edge Function is missing `SUPABASE_SECRET_KEY` environment variable.

**Solution:**
1. Go to Supabase Dashboard → Project Settings → Edge Functions → Secrets
2. Add `SUPABASE_SECRET_KEY` with your service role key (found in Project Settings → API)
3. Also add:
   - `SUPABASE_URL` - Your project URL
   - `SUPABASE_PUBLISHABLE_KEY` - Your anon/public key
4. Redeploy: `supabase functions deploy listings-create`

### 2. "Cannot read property 'Base64' of undefined"

**Problem:** Using wrong encoding format for expo-file-system.

**Solution:** Use string `'base64'` instead of `FileSystem.EncodingType.Base64`:

```typescript
// ✅ Correct
const base64 = await FileSystem.readAsStringAsync(uri, {
  encoding: 'base64'
});

// ❌ Incorrect
const base64 = await FileSystem.readAsStringAsync(uri, {
  encoding: FileSystem.EncodingType.Base64
});
```

### 3. Migration Failing with "Internal server error"

**Checklist:**
- [ ] Edge Functions have all required secrets set
- [ ] User is authenticated before migrating
- [ ] Images are in correct format (base64 string or file URI)
- [ ] Quota not exceeded: `await checkQuota()`

## Detailed Solutions

### Environment Variables Not Set

**Symptoms:**
- "Missing Supabase configuration" error
- "Server configuration error" from Edge Functions
- Functions return 500 errors

**Fix:**
1. **Frontend (.env):**
   ```env
   EXPO_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
   EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_anon_key
   ```

2. **Backend (Supabase Dashboard):**
   - Go to: Project Settings → Edge Functions → Secrets
   - Add:
     - `SUPABASE_URL`
     - `SUPABASE_SECRET_KEY` (service role key)
     - `SUPABASE_PUBLISHABLE_KEY` (anon key)

### Image Upload Issues

**Symptoms:**
- "Upload failed" errors
- Images not appearing
- File size errors

**Fix:**
- Maximum file size: 10MB
- Supported formats: JPEG, PNG, WebP
- Ensure image is base64 encoded: `data:image/jpeg;base64,...`

### Quota Exceeded

**Symptoms:**
- "QUOTA_EXCEEDED" error code
- Can't create new listings

**Fix:**
- Free tier: 10 listings per 30 days
- Check quota: `await checkQuota()`
- Options:
  1. Wait for quota to reset (30-day rolling window)
  2. Purchase credits
  3. Upgrade to Pro plan

### Authentication Issues

**Symptoms:**
- "Not authenticated" errors
- "Unauthorized" responses
- Session not persisting

**Fix:**
1. Ensure user is signed in:
   ```typescript
   const { user } = await getUser();
   if (!user) {
     await signIn(email, password);
   }
   ```

2. Check session:
   ```typescript
   const { session } = await getSession();
   console.log('Session:', session?.access_token ? 'Valid' : 'Invalid');
   ```

3. Verify Supabase Auth is enabled in your project

### Edge Function Errors

**Check logs:**
```bash
supabase functions logs listings-create
supabase functions logs upload
```

**Common issues:**
- Missing environment variables → Add secrets in Dashboard
- Database errors → Run migrations: `supabase db push`
- RLS policy issues → Check policies in Dashboard

### TypeScript Errors

**Symptoms:**
- "Cannot find module '@supabase/supabase-js'"
- "Cannot find module 'expo-secure-store'"

**Fix:**
```bash
npm install @supabase/supabase-js expo-secure-store expo-file-system expo-image-picker
```

These errors are expected in the example files until you install dependencies in your project.

## Getting Help

1. **Check logs:**
   - Frontend: React Native debugger console
   - Backend: `supabase functions logs <function-name>`
   - Database: Supabase Dashboard → Logs

2. **Verify setup:**
   - All environment variables set
   - Edge Functions deployed
   - Database migrations applied
   - User authenticated

3. **Test individually:**
   ```typescript
   // Test auth
   const { user } = await getUser();

   // Test quota
   const { quota } = await checkQuota();

   // Test upload
   const { data } = await uploadImage(base64Image);
   ```

## Still Having Issues?

1. Check the main backend `README.md` for API documentation
2. Review `SETUP.md` for detailed setup instructions
3. Verify all steps in the setup guide were completed
4. Check Supabase Dashboard for any service issues
