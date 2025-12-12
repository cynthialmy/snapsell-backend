# Payment Credits Fix

## Problem

Payments were being recorded in the `stripe_payments` table, but credits were not being added to user accounts. This happened due to several potential issues:

1. **Stripe webhook events don't include `line_items` by default** in `checkout.session.completed` events
2. **Credits couldn't be determined** from metadata or line items
3. **The webhook handler wasn't fetching expanded session data** from Stripe API
4. **User profile might not exist** - if the trigger failed, `users_profile` might not exist for a user
5. **Silent failures** - errors in credit increment were caught but payment was still recorded
6. **No transaction wrapping** - payment insert happens even if credit update fails
7. **User ID mismatch** - `client_reference_id` might not match `auth.users.id` or `users_profile.id`

## Solution

### 1. Enhanced Webhook Handler (`stripe-webhook`)

**Changes made:**
- **User verification**: Verifies user exists in `auth.users` before processing
- **Profile existence check**: Ensures `users_profile` exists before updating credits
- Added better logging to track payment processing
- Enhanced credit detection logic:
  - First checks `session.metadata.credits`
  - Then checks `session.line_items.data` (if expanded)
  - **NEW:** Fetches session with expanded line items from Stripe API if not found
  - Falls back to amount-based inference ($5=10, $10=25, $20=60 credits)
- **Improved error handling**: Uses `safe_increment_credits` with multiple fallbacks
- **Transaction safety**: Only records payment if credits were successfully added
- Added logic to fix existing payments that were completed but credits weren't added
- Handles updating existing pending payments instead of creating duplicates

**Key improvements:**
- Fetches expanded session data from Stripe API when line items aren't available
- Better error messages and logging
- Retroactive fix for existing payments

### 2. Database Functions

Created migrations with several helper functions:

#### Migration `20240101000007_fix_missing_credits.sql`:

#### `fix_missing_credits_for_payments()`
Processes all completed credit payments where credits = 0 or NULL.

**Usage:**
```sql
SELECT * FROM public.fix_missing_credits_for_payments();
```

Returns a table with:
- `payment_id`: UUID of the payment
- `user_id`: UUID of the user
- `credits_added`: Number of credits added
- `success`: Boolean indicating success
- `error_message`: Error message if failed

#### `fix_missing_credits_for_payment(p_session_id, p_credits)`
Fixes credits for a specific payment by session ID.

**Usage:**
```sql
-- Auto-detect credits from metadata/amount
SELECT * FROM public.fix_missing_credits_for_payment('cs_test_...');

-- Manually specify credits
SELECT * FROM public.fix_missing_credits_for_payment('cs_test_...', 25);
```

Returns JSONB with success status and details.

#### Migration `20240101000008_ensure_users_profile.sql`:

**`ensure_users_profile_exists(p_user_id)`**
Ensures a `users_profile` record exists for a user. Creates it if missing.

**`safe_increment_credits(p_user_id, p_amount)`**
Enhanced credit increment function that:
- Ensures profile exists before updating
- Returns detailed success/error information
- Handles edge cases better than `increment_credits`

**Usage:**
```sql
-- Ensure profile exists
SELECT public.ensure_users_profile_exists('user-uuid');

-- Safely increment credits
SELECT * FROM public.safe_increment_credits('user-uuid', 25);
```

#### Migration `20240101000009_diagnostic_queries.sql`:

Contains diagnostic queries to identify payment issues:
1. Payments with missing credits
2. Users without profiles
3. User ID mismatches
4. Payments needing fixes
5. Summary statistics

### 3. Edge Function: `fix-missing-credits`

Created a new Edge Function to fix missing credits via API.

**Endpoint:** `POST /functions/v1/fix-missing-credits`

**Authentication:** Requires service role key in Authorization header

**Request body options:**

1. **Fix specific payment:**
```json
{
  "session_id": "cs_test_...",
  "credits": 25  // Optional: manually specify credits
}
```

2. **Fix all missing credits:**
```json
{
  "fix_all": true
}
```

**Example using curl:**
```bash
curl -X POST https://your-project.supabase.co/functions/v1/fix-missing-credits \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fix_all": true}'
```

## How to Fix Existing Payments

### Option 1: Using SQL (Recommended)

1. **Connect to your Supabase database** (via Supabase Dashboard SQL Editor or `psql`)

2. **Fix all missing credits:**
```sql
SELECT * FROM public.fix_missing_credits_for_payments();
```

3. **Fix specific payment:**
```sql
SELECT * FROM public.fix_missing_credits_for_payment('cs_test_...');
```

### Option 2: Using Edge Function

1. **Get your service role key** from Supabase Dashboard → Settings → API

2. **Call the fix function:**
```bash
curl -X POST https://your-project.supabase.co/functions/v1/fix-missing-credits \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fix_all": true}'
```

### Option 3: Webhook Will Auto-Fix

The enhanced webhook handler will automatically fix missing credits when:
- A webhook event is received for a payment that was already completed
- The payment record exists but credits = 0 or NULL
- Credits can be determined from metadata or amount

## Diagnosis

Before fixing, run these diagnostic queries to identify the root cause:

### 1. Check for Common Issues

Run the diagnostic queries from `20240101000009_diagnostic_queries.sql`:

```sql
-- Check for payments with missing credits
SELECT
  sp.id,
  sp.user_id,
  sp.stripe_session_id,
  sp.amount,
  sp.credits,
  sp.status,
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
```

### 2. Check for Users Without Profiles

```sql
SELECT
  au.id as auth_user_id,
  au.email,
  up.id as profile_id,
  CASE WHEN up.id IS NULL THEN 'PROFILE_MISSING' ELSE 'OK' END as status
FROM auth.users au
LEFT JOIN users_profile up ON au.id = up.id
WHERE up.id IS NULL;
```

### 3. Check User ID Mismatches

```sql
SELECT
  sp.user_id as payment_user_id,
  up.id as profile_id,
  CASE
    WHEN up.id IS NULL THEN 'PROFILE_NOT_FOUND'
    WHEN sp.user_id != up.id THEN 'ID_MISMATCH'
    ELSE 'OK'
  END as issue
FROM stripe_payments sp
LEFT JOIN users_profile up ON sp.user_id = up.id
WHERE sp.status = 'completed';
```

## Verification

After running the fix, verify credits were added:

```sql
-- Check payments that were fixed
SELECT
  sp.id,
  sp.user_id,
  sp.credits,
  sp.amount,
  sp.status,
  up.credits as user_current_credits
FROM stripe_payments sp
JOIN users_profile up ON sp.user_id = up.id
WHERE sp.status = 'completed'
  AND sp.type = 'credits'
ORDER BY sp.created_at DESC;
```

## Prevention

The enhanced webhook handler now:
1. ✅ Fetches expanded session data from Stripe API
2. ✅ Better handles metadata and line items
3. ✅ Has fallback logic for amount-based inference
4. ✅ Automatically fixes existing payments on webhook retry
5. ✅ Better error handling and logging

## Testing

To test the fix:

1. **Create a test payment** (or use an existing one)
2. **Check if credits were added:**
```sql
SELECT credits FROM users_profile WHERE id = 'user-uuid';
```
3. **If credits are missing, run the fix:**
```sql
SELECT * FROM public.fix_missing_credits_for_payment('session-id');
```
4. **Verify credits were added:**
```sql
SELECT credits FROM users_profile WHERE id = 'user-uuid';
```

## Deployment

1. **Deploy all migrations:**
```bash
supabase db push
```

This will deploy:
- `20240101000007_fix_missing_credits.sql` - Fix functions
- `20240101000008_ensure_users_profile.sql` - Safe credit increment functions
- `20240101000009_diagnostic_queries.sql` - Diagnostic queries (for reference)

2. **Deploy the updated webhook function:**
```bash
supabase functions deploy stripe-webhook
```

3. **Deploy the new fix function (optional):**
```bash
supabase functions deploy fix-missing-credits
```

## Root Cause Analysis

The issues you identified are all valid potential causes:

### ✅ 1. User ID Mismatch
**Fixed:** Added verification that user exists in `auth.users` and that `users_profile` exists before processing.

### ✅ 2. Webhook Error (Silent Failure)
**Fixed:**
- Changed to use `safe_increment_credits` with proper error handling
- Multiple fallback methods (RPC → direct update)
- Payment is **NOT recorded** if credits can't be added (prevents orphaned payments)

### ✅ 3. Credits Field Issue
**Verified:** Credits column exists and is correct type (`integer DEFAULT 0`)

### ✅ 4. Transaction Issue
**Fixed:**
- Payment insert now happens **AFTER** credits are successfully added
- If credit update fails, payment is not recorded
- This prevents the "payment recorded but credits not added" scenario

### Additional Fixes:
- **Profile existence check**: Ensures `users_profile` exists before updating
- **Better error logging**: All errors are logged with context
- **Idempotency**: Safe to retry webhook events

## Notes

- The fix functions are idempotent - safe to run multiple times
- Credits are determined from metadata first, then amount inference
- The webhook will automatically fix missing credits on retry
- All operations are logged for debugging


