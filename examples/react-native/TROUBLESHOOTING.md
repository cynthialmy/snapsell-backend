# Troubleshooting Guide

Common issues and solutions when integrating SnapSell backend with your React Native app.

## Quick Fixes

### 1. "Server configuration error" or Missing Supabase Keys

**Problem:** Edge Function cannot access Supabase environment variables.

**Solution:**
Edge Functions automatically have access to `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. If you see this error, it usually means:
1. The Edge Function hasn't been deployed yet
2. There's an issue with your Supabase project configuration

**No manual configuration needed!** The Supabase keys are automatically provided by the Edge Functions runtime.

If the error persists, try redeploying:
```bash
supabase functions deploy listings-create
```

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
   EXPO_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
   ```

2. **Backend (Edge Functions):**
   - **No configuration needed!** Edge Functions automatically have access to:
     - `SUPABASE_URL`
     - `SUPABASE_ANON_KEY`
     - `SUPABASE_SERVICE_ROLE_KEY`
   - These are provided automatically by Supabase - you don't need to set them manually
   - Only set secrets for external services (LLM API keys, PostHog, etc.)

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
