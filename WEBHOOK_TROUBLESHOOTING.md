# Stripe Webhook 401 Error Troubleshooting

## Problem

You're seeing 401 Unauthorized errors when Stripe sends webhooks to your endpoint. This means the webhook signature verification is failing.

## Common Causes

### 1. Wrong Webhook Secret

The webhook secret in your environment variables doesn't match the one in Stripe Dashboard.

**Solution:**
1. Go to Stripe Dashboard → Developers → Webhooks
2. Click on your webhook endpoint
3. Click "Reveal" next to "Signing secret"
4. Copy the webhook secret (starts with `whsec_`)
5. Update your Supabase Edge Function secrets:

```bash
# For production
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...

# For test mode
supabase secrets set STRIPE_WEBHOOK_SECRET_SANDBOX=whsec_...
supabase secrets set STRIPE_MODE=test
```

### 2. Test vs Production Mode Mismatch

You're using a test mode webhook secret but Stripe is sending production webhooks (or vice versa).

**Solution:**
- Check `STRIPE_MODE` environment variable
- Ensure you're using the correct webhook secret for the mode
- Test mode webhooks use `STRIPE_WEBHOOK_SECRET_SANDBOX`
- Production webhooks use `STRIPE_WEBHOOK_SECRET`

### 3. Webhook Endpoint URL Mismatch

The webhook endpoint URL in Stripe doesn't match your Supabase function URL.

**Solution:**
1. Get your function URL:
   ```
   https://YOUR_PROJECT_REF.supabase.co/functions/v1/stripe-webhook
   ```

2. Update in Stripe Dashboard:
   - Go to Developers → Webhooks
   - Edit your webhook endpoint
   - Update the URL to match your Supabase function URL

### 4. Webhook Secret Not Set

The environment variable is not set or is empty.

**Check:**
```bash
# List all secrets
supabase secrets list

# Check if webhook secret exists
supabase secrets get STRIPE_WEBHOOK_SECRET
```

## Verification Steps

### Step 1: Check Environment Variables

```bash
# Check production webhook secret
supabase secrets get STRIPE_WEBHOOK_SECRET

# Check test mode webhook secret
supabase secrets get STRIPE_WEBHOOK_SECRET_SANDBOX

# Check mode setting
supabase secrets get STRIPE_MODE
```

### Step 2: Verify Stripe Dashboard

1. Go to Stripe Dashboard → Developers → Webhooks
2. Find your webhook endpoint
3. Click on it to see details
4. Check:
   - **Status**: Should be "Enabled"
   - **URL**: Should match your Supabase function URL
   - **Signing secret**: Copy this and compare with your env var

### Step 3: Test Webhook Locally

You can test webhook signature verification locally:

```bash
# Install Stripe CLI
stripe listen --forward-to http://localhost:54321/functions/v1/stripe-webhook

# In another terminal, trigger a test event
stripe trigger payment_intent.succeeded
```

The Stripe CLI will show you the webhook secret to use.

### Step 4: Check Logs

Check your Supabase function logs for detailed error messages:

```bash
supabase functions logs stripe-webhook
```

Look for:
- "Missing stripe-signature header" - Stripe isn't sending signature
- "Invalid signature verification" - Signature doesn't match
- "Missing STRIPE_WEBHOOK_SECRET" - Secret not configured

## Quick Fix

If you just need to get it working quickly:

1. **Get the webhook secret from Stripe:**
   - Stripe Dashboard → Developers → Webhooks
   - Click your endpoint → Click "Reveal" on signing secret

2. **Set it in Supabase:**
   ```bash
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_YOUR_SECRET_HERE
   ```

3. **Redeploy the function:**
   ```bash
   supabase functions deploy stripe-webhook
   ```

4. **Test by triggering a payment:**
   - Make a test payment
   - Check Stripe Dashboard → Webhooks → Your endpoint → Recent events
   - Should show 200 OK instead of 401

## Environment Variables Checklist

Make sure these are set correctly:

- ✅ `STRIPE_WEBHOOK_SECRET` - Production webhook signing secret (starts with `whsec_`)
- ✅ `STRIPE_WEBHOOK_SECRET_SANDBOX` - Test mode webhook signing secret (optional, if using test mode)
- ✅ `STRIPE_MODE` - Set to `"test"` for test mode, or leave unset/default for production
- ✅ `STRIPE_SECRET_KEY` - Stripe API secret key
- ✅ `SUPABASE_URL` - Your Supabase project URL (auto-set)
- ✅ `SUPABASE_SERVICE_ROLE_KEY` - Service role key (auto-set)

## Important Notes

- **Each webhook endpoint has its own secret** - If you have multiple endpoints, each needs its own secret
- **Secrets are different for test/live mode** - Test mode webhooks use different secrets
- **Secrets start with `whsec_`** - If your secret doesn't start with this, it's wrong
- **Never commit secrets to git** - Always use Supabase secrets or environment variables

## Fix: Disable JWT Verification

The 401 error is likely because Supabase Edge Functions have JWT verification enabled by default. Even though `config.toml` has `verify_jwt = false`, you need to deploy with the explicit flag.

**Deploy the function with JWT verification disabled:**
```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

**OR** if you're using the Supabase Dashboard:
1. Go to Edge Functions → stripe-webhook → Settings
2. Toggle off "Verify JWT"
3. Save and redeploy

## Fix: Use Stripe SDK for Signature Verification

The webhook handler has been updated to use Stripe's official SDK for signature verification, which properly handles `whsec_` prefixed secrets (they're base64 encoded and need decoding).

**Deploy the updated function:**
```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

The updated code:
- Uses Stripe SDK's `constructEventAsync` for signature verification
- Automatically handles `whsec_` secret decoding
- Falls back to manual verification if SDK fails (for debugging)

## Still Not Working?

1. **Deploy the updated function** - The latest version uses Stripe SDK for proper signature verification
2. Check the function logs for detailed error messages
3. Verify the webhook secret matches exactly (no extra spaces, correct mode)
4. Make sure you're using the webhook secret, not the API secret key
5. Try creating a new webhook endpoint in Stripe and using that secret
6. Check that `config.toml` has `verify_jwt = false` (already set)


