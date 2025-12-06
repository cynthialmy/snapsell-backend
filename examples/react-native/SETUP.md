# Frontend Setup Guide

This guide will help you set up the SnapSell backend integration in your React Native/Expo app.

## Step 1: Install Dependencies

```bash
npm install @supabase/supabase-js expo-secure-store expo-file-system expo-image-picker
```

Or with yarn:

```bash
yarn add @supabase/supabase-js expo-secure-store expo-file-system expo-image-picker
```

## Step 2: Configure Environment Variables

### Option A: Using `.env` file (Recommended for Expo)

Create a `.env` file in your project root:

```env
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_publishable_key_here
EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL=https://your-project.supabase.co/functions/v1
```

**Note:** The `EXPO_PUBLIC_` prefix is required for Expo to expose these variables to your app.

### Option B: Using `app.config.js` (Expo)

```javascript
export default {
  expo: {
    // ... other config
    extra: {
      supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      supabaseFunctionsUrl: process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL,
    },
  },
};
```

Then access via `Constants.expoConfig.extra` in your app.

## Step 3: Copy Example Files

Copy the example files to your project:

```bash
# From your project root
cp examples/react-native/auth.ts src/utils/
cp examples/react-native/listings.ts src/utils/
```

Or manually copy:
- `examples/react-native/auth.ts` → `src/utils/auth.ts`
- `examples/react-native/listings.ts` → `src/utils/listings.ts`

## Step 4: Update Imports

The example files import from `'./auth'`. Make sure your file structure matches:

```
src/
  utils/
    auth.ts
    listings.ts
```

If your structure is different, update the import in `listings.ts`:

```typescript
// Change this:
import { supabase } from './auth';

// To match your structure:
import { supabase } from '../auth'; // or wherever auth.ts is
```

## Step 5: Verify Configuration

Add this to your app to verify the connection:

```typescript
import { getUser } from './utils/auth';
import { checkQuota } from './utils/listings';

// Test authentication
const { user, error } = await getUser();
if (user) {
  console.log('✅ Connected! User:', user.email);

  // Test quota check
  const { quota } = await checkQuota();
  console.log('✅ Quota check:', quota);
} else {
  console.error('❌ Not authenticated:', error);
}
```

## Step 6: Deploy Edge Functions

Make sure all Edge Functions are deployed to your Supabase project:

```bash
cd /path/to/snapsell-backend
supabase functions deploy upload
supabase functions deploy generate
supabase functions deploy listings-create
supabase functions deploy listings-get-by-slug
supabase functions deploy feedback-create
supabase functions deploy usage-check-quota
```

## Troubleshooting

### "Missing Supabase configuration" Error

- Check that your `.env` file has `EXPO_PUBLIC_` prefix
- Restart your Expo dev server after adding environment variables
- Verify the values are correct (no extra spaces, correct URLs)

### "Not authenticated" Errors

- Make sure you've signed in: `await signIn(email, password)`
- Check that your Supabase project has authentication enabled
- Verify your Supabase URL and keys are correct

### "Internal server error" When Creating Listings

- Check Edge Function logs: `supabase functions logs listings-create`
- Verify all environment variables are set in Supabase Dashboard → Edge Functions → Secrets
- Check that database migrations have been applied: `supabase db push`

### "supabaseKey is required" or "Missing required environment variables"

This error means the Edge Function cannot access Supabase configuration.

**Good news:** Edge Functions automatically have access to Supabase keys! You don't need to manually configure:
- `SUPABASE_URL` - Automatically available
- `SUPABASE_ANON_KEY` - Automatically available
- `SUPABASE_SERVICE_ROLE_KEY` - Automatically available

**If you see this error:**
1. Make sure the Edge Function is deployed:
   ```bash
   supabase functions deploy listings-create
   ```

2. Check that your Supabase project is properly configured

3. Only set secrets for external services (LLM API keys, PostHog, etc.) - not for Supabase keys

**Note:** The `FREE_LISTING_LIMIT` can be set as a secret if you want to override the default (10), but it's optional.

### TypeScript Errors About Missing Modules

These are expected until you install the dependencies in your project. After installing:

```bash
npm install @supabase/supabase-js expo-secure-store expo-file-system expo-image-picker
```

The errors should disappear.

### Migration Errors

If migrating local listings fails:

1. Check that images are in the correct format (base64 or file URI)
2. Verify you're authenticated before migrating
3. Check quota: `await checkQuota()` - you may have exceeded your limit
4. Review error details in the migration result

### "Cannot read property 'Base64' of undefined" Error

This error occurs when reading local image files. The example code has been updated to use the correct encoding format. If you're still seeing this error:

1. **Make sure you're using the latest version of the example file**
2. **Verify expo-file-system is installed:**
   ```bash
   npm install expo-file-system
   ```
3. **The encoding should be a string, not an enum:**
   ```typescript
   // Correct:
   { encoding: 'base64' }

   // Incorrect:
   { encoding: FileSystem.EncodingType.Base64 }
   ```

If you're using your own implementation, ensure you're using the string `'base64'` instead of `FileSystem.EncodingType.Base64`.

## Next Steps

- See `README.md` for usage examples
- Check the main backend `README.md` for API documentation
- Review `BACKEND_VERIFICATION_REPORT.md` to understand what's implemented

## Support

If you encounter issues:

1. Check Supabase Dashboard → Logs for Edge Function errors
2. Review the backend `README.md` troubleshooting section
3. Verify all migrations are applied: `supabase db push`
