# Edge Functions JWT Configuration Guide

## Overview

Supabase Edge Functions have JWT verification enabled by default. This means they expect an `Authorization` header with a valid JWT token. However, some functions need to accept requests from external services (like Stripe webhooks) or allow unauthenticated access.

## Functions with JWT Disabled

These functions should have `verify_jwt = false` in their `config.toml`:

### 1. `stripe-webhook` ✅
- **Reason**: External webhook from Stripe (doesn't send JWT tokens)
- **Config**: `supabase/functions/stripe-webhook/config.toml`
- **Deploy**: `supabase functions deploy stripe-webhook --no-verify-jwt`

### 2. `payment-success` ✅
- **Reason**: Public HTML page shown after Stripe checkout (no auth needed)
- **Config**: `supabase/functions/payment-success/config.toml`
- **Deploy**: `supabase functions deploy payment-success --no-verify-jwt`

### 3. `analyze-image` ✅
- **Reason**: Allows unauthenticated users (with rate limiting)
- **Config**: `supabase/functions/analyze-image/config.toml`
- **Deploy**: `supabase functions deploy analyze-image --no-verify-jwt`
- **Note**: Function handles auth manually - checks for optional Authorization header

### 4. `fix-missing-credits` ✅
- **Reason**: Admin function that requires service role key (not JWT)
- **Config**: `supabase/functions/fix-missing-credits/config.toml`
- **Deploy**: `supabase functions deploy fix-missing-credits --no-verify-jwt`
- **Note**: Function validates service role key manually

## Functions with JWT Enabled (Default)

These functions require authentication and should **keep JWT verification enabled**:

- ✅ `create-checkout-session` - Requires authenticated user
- ✅ `verify-payment` - Requires authenticated user
- ✅ `listings-create` - Requires authenticated user
- ✅ `listings-get` - Requires authenticated user
- ✅ `listings-get-by-slug` - Public but may check auth for private listings
- ✅ `upload` - Requires authenticated user
- ✅ `generate` - Requires authenticated user
- ✅ `feedback-create` - Requires authenticated user
- ✅ `delete-account` - Requires authenticated user
- ✅ `usage-check-quota` - Requires authenticated user

**Note**: These functions don't need `config.toml` files - JWT verification is enabled by default.

## Deployment Commands

### Deploy functions with JWT disabled:
```bash
# Stripe webhook (external service)
supabase functions deploy stripe-webhook --no-verify-jwt

# Payment success page (public)
supabase functions deploy payment-success --no-verify-jwt

# Analyze image (optional auth)
supabase functions deploy analyze-image --no-verify-jwt

# Fix missing credits (admin function)
supabase functions deploy fix-missing-credits --no-verify-jwt
```

### Deploy functions with JWT enabled (default):
```bash
# All other functions - JWT enabled by default
supabase functions deploy create-checkout-session
supabase functions deploy verify-payment
supabase functions deploy listings-create
# ... etc
```

## Security Considerations

### ✅ Safe to Disable JWT:
- External webhooks (Stripe, etc.) - They use their own signature verification
- Public pages (payment success, etc.) - No sensitive data
- Functions with manual auth checks - They validate auth themselves

### ⚠️ Keep JWT Enabled:
- User-facing APIs - Need to verify user identity
- Functions that access user data - Require authentication
- Admin functions called by frontend - Should use JWT

## Best Practices

1. **Always use `--no-verify-jwt` flag** when deploying functions that have `verify_jwt = false` in config.toml
2. **Document why** JWT is disabled in the function's comments
3. **Implement alternative auth** if disabling JWT (e.g., signature verification, service role key check)
4. **Test authentication** after deploying with JWT disabled

## Current Status

| Function | JWT Status | Config File | Reason |
|----------|-----------|-------------|--------|
| `stripe-webhook` | ❌ Disabled | ✅ Yes | External webhook |
| `payment-success` | ❌ Disabled | ✅ Yes | Public page |
| `analyze-image` | ❌ Disabled | ✅ Yes | Optional auth |
| `fix-missing-credits` | ❌ Disabled | ✅ Yes | Service role only |
| All others | ✅ Enabled | ❌ No (default) | User authentication |

## Troubleshooting

If you get 401 errors:

1. **Check if function needs JWT disabled:**
   - Is it called by external service? → Disable JWT
   - Is it a public page? → Disable JWT
   - Does it handle auth manually? → Disable JWT

2. **Verify config.toml exists:**
   ```bash
   ls supabase/functions/[function-name]/config.toml
   ```

3. **Redeploy with correct flag:**
   ```bash
   # If JWT should be disabled:
   supabase functions deploy [function-name] --no-verify-jwt

   # If JWT should be enabled (default):
   supabase functions deploy [function-name]
   ```

4. **Check function logs:**
   ```bash
   supabase functions logs [function-name]
   ```

