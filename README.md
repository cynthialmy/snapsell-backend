# SnapSell Backend

Complete Supabase backend implementation for SnapSell, including authentication, listing management, sharing, feedback, and freemium model enforcement.

## Overview

This backend provides:
- **User Authentication**: Email/password and magic link authentication via Supabase Auth
- **Listing Management**: Create, update, delete listings with AI-generated content
- **Sharing**: Public share links with view tracking
- **Feedback System**: App and listing feedback with optional attachments
- **Freemium Model**: Quota enforcement (10 free listings per 30 days) with credit system
- **Stripe Integration**: Webhook handling for subscriptions and credit purchases

## Tech Stack

- **Supabase**: Auth, Postgres, Storage, Edge Functions
- **PostgreSQL**: Database with Row-Level Security (RLS)
- **Deno**: Edge Functions runtime
- **Stripe**: Payment processing (subscriptions and credits)

## Prerequisites

- Node.js 18+ and npm
- Supabase CLI (`npm install -g supabase`)
- Supabase account and project
- Stripe account (for payments)
- Deno (for local Edge Function development)

## Setup

### 1. Install Supabase CLI

```bash
npm install -g supabase
```

### 2. Initialize Supabase Project

```bash
# Login to Supabase
supabase login

# Link to your project (or create new)
supabase link --project-ref your-project-ref

# Or start local development
supabase start
```

### 3. Run Migrations

```bash
# Apply all migrations
supabase db reset

# Or apply migrations to remote
supabase db push
```

Migrations are located in `supabase/migrations/`:
- `20240101000000_initial_schema.sql` - Database tables
- `20240101000001_rls_policies.sql` - Row-Level Security policies
- `20240101000002_functions_and_triggers.sql` - Database functions and triggers
- `20240101000003_storage_policies.sql` - Storage bucket policies

### 4. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required variables:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key (for admin operations)
- `STRIPE_SECRET_KEY` - Stripe secret key
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook signing secret
- `FREE_LISTING_LIMIT` - Free tier listing limit (default: 10)

### 5. Deploy Edge Functions

```bash
# Deploy all functions
supabase functions deploy upload
supabase functions deploy generate
supabase functions deploy listings-create
supabase functions deploy listings-get-by-slug
supabase functions deploy feedback-create
supabase functions deploy stripe-webhook
supabase functions deploy usage-check-quota

# Or deploy all at once (if supported)
supabase functions deploy
```

### 6. Configure Stripe Webhook

1. Go to Stripe Dashboard → Webhooks
2. Add endpoint: `https://your-project.supabase.co/functions/v1/stripe-webhook`
3. Select events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
4. Copy the webhook signing secret to `STRIPE_WEBHOOK_SECRET`

### 7. Set Up Storage Bucket

The storage bucket `items` is created automatically via migration. Verify in Supabase Dashboard → Storage.

## Project Structure

```
snapsell-backend/
├── supabase/
│   ├── migrations/          # Database migrations
│   ├── functions/            # Edge Functions
│   │   ├── upload/
│   │   ├── generate/
│   │   ├── listings-create/
│   │   ├── listings-get-by-slug/
│   │   ├── feedback-create/
│   │   ├── stripe-webhook/
│   │   └── usage-check-quota/
│   └── config.toml          # Supabase configuration
├── examples/
│   └── react-native/        # React Native integration examples
├── tests/                   # Test files
├── .env.example             # Environment variables template
└── README.md               # This file
```

## API Endpoints

### Edge Functions

All Edge Functions are available at: `https://your-project.supabase.co/functions/v1/{function-name}`

#### `POST /upload`
Upload image to Supabase Storage.

**Headers:**
- `Authorization: Bearer {token}` (required)

**Body:**
```json
{
  "file": "data:image/jpeg;base64,...",
  "contentType": "image/jpeg"
}
```

**Response:**
```json
{
  "storage_path": "items/{user_id}/{uuid}.jpg",
  "public_url": "https://...",
  "filename": "{uuid}.jpg"
}
```

#### `POST /generate`
Generate listing content from image (stubbed for v1).

**Body:**
```json
{
  "storage_path": "items/{user_id}/{uuid}.jpg"
}
```

**Response:**
```json
{
  "ai_generated": {...},
  "title": "Vintage Wooden Chair",
  "description": "...",
  "price_cents": 7500,
  "currency": "USD",
  "condition": "Good",
  "category": "Furniture",
  "tags": ["vintage", "wood", "chair"]
}
```

#### `POST /listings-create`
Create a new listing with quota enforcement.

**Headers:**
- `Authorization: Bearer {token}` (required)

**Body:**
```json
{
  "title": "Vintage Chair",
  "description": "...",
  "price_cents": 7500,
  "currency": "USD",
  "condition": "Good",
  "category": "Furniture",
  "tags": ["vintage", "wood"],
  "storage_path": "items/{user_id}/{uuid}.jpg",
  "visibility": "shared"
}
```

**Response (Success):**
```json
{
  "listing": {...},
  "quota": {
    "used": 5,
    "limit": 10,
    "remaining": 5
  }
}
```

**Response (Quota Exceeded - 402):**
```json
{
  "error": "Quota exceeded",
  "code": "QUOTA_EXCEEDED",
  "used": 10,
  "limit": 10,
  "remaining": 0,
  "message": "You've reached your free listing limit..."
}
```

#### `GET /listings-get-by-slug/:slug`
Get public listing by share slug (no auth required).

**Response:**
```json
{
  "id": "...",
  "title": "...",
  "description": "...",
  "image_url": "https://...",
  "share_slug": "abc123xyz"
}
```

#### `POST /feedback-create`
Submit feedback (auth optional).

**Body:**
```json
{
  "type": "app",
  "rating": 5,
  "comment": "Great app!",
  "listing_id": "..." // optional for listing feedback
}
```

#### `POST /stripe-webhook`
Handle Stripe webhook events (called by Stripe).

#### `GET /usage-check-quota`
Check current usage and quota.

**Headers:**
- `Authorization: Bearer {token}` (required)

**Response:**
```json
{
  "used": 5,
  "limit": 10,
  "remaining": 5,
  "hasCredits": true,
  "credits": 10,
  "plan": "free"
}
```

## Database Schema

### Tables

- **users_profile**: User profiles extending auth.users
- **listings**: User listings with AI-generated content
- **listing_views**: View tracking for shared listings
- **feedback**: App and listing feedback
- **usage_logs**: Usage tracking for quota enforcement
- **subscriptions**: Stripe subscription mirror

See `supabase/migrations/20240101000000_initial_schema.sql` for full schema.

## Security

### Row-Level Security (RLS)

All tables have RLS enabled with policies ensuring:
- Users can only access their own data
- Public/shared listings are readable via share_slug
- Anonymous feedback is allowed
- Service role can perform admin operations

### Storage Policies

- Users can upload/read/delete files in their own folder: `items/{user_id}/*`
- Public access via signed URLs only (generated by Edge Functions)

## Freemium Model

### Free Tier
- 10 listings per 30-day rolling window (configurable via `FREE_LISTING_LIMIT`)
- Unlimited local generation (no save to server)

### Paid Tier (Pro)
- Unlimited listings
- Set via Stripe subscription

### Credits
- Users can purchase credit packs
- 1 credit = 1 saved listing
- Credits are used when free quota is exceeded

### Enforcement
- Quota checked before listing creation
- HTTP 402 returned when quota exceeded
- Credits automatically deducted when needed

## React Native Integration

See `examples/react-native/` for complete integration examples:

- `auth.ts` - Authentication functions
- `listings.ts` - Listing management and API calls
- `README.md` - Usage guide

## Testing

### RLS Policy Tests

Run SQL tests in `tests/rls-policies.test.sql` to verify RLS policies:

```bash
# In Supabase SQL Editor or psql
\i tests/rls-policies.test.sql
```

### Edge Function Tests

Test files are provided in each function directory (`test.ts`). Full test implementation requires:
- Mock Supabase client
- Test fixtures
- Deno test framework setup

## Local Development

### Start Local Supabase

```bash
supabase start
```

This starts:
- PostgreSQL database (port 54322)
- Supabase Studio (port 54323)
- Edge Functions runtime (port 54327)
- Inbucket (email testing, port 54324)

### Run Migrations Locally

```bash
supabase db reset
```

### Test Edge Functions Locally

```bash
# Serve function locally
supabase functions serve upload --no-verify-jwt

# Test with curl
curl -X POST http://localhost:54321/functions/v1/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"file": "data:image/jpeg;base64,..."}'
```

## Deployment

### Deploy to Production

1. **Database Migrations:**
   ```bash
   supabase db push
   ```

2. **Edge Functions:**
   ```bash
   supabase functions deploy upload
   supabase functions deploy generate
   # ... deploy all functions
   ```

3. **Environment Variables:**
   Set secrets in Supabase Dashboard → Project Settings → Edge Functions → Secrets

4. **Stripe Webhook:**
   Update webhook URL to production Edge Function URL

## Troubleshooting

### Migration Errors

If migrations fail:
1. Check Supabase logs: `supabase logs`
2. Verify database connection
3. Ensure extensions are enabled: `CREATE EXTENSION IF NOT EXISTS "pgcrypto";`

### Edge Function Errors

1. Check function logs: `supabase functions logs {function-name}`
2. Verify environment variables are set
3. Test locally first: `supabase functions serve {function-name}`

### RLS Policy Issues

1. Verify RLS is enabled: `SELECT * FROM pg_tables WHERE rowsecurity = true;`
2. Check policies: `SELECT * FROM pg_policies WHERE tablename = 'listings';`
3. Test with different user contexts

### Storage Access Issues

1. Verify bucket exists: Check Supabase Dashboard → Storage
2. Check storage policies: `SELECT * FROM storage.policies;`
3. Ensure file paths match policy patterns: `items/{user_id}/*`

## Environment Variables

See `.env.example` for all required variables.

## Support

For issues or questions:
1. Check Supabase documentation: https://supabase.com/docs
2. Review Edge Functions docs: https://supabase.com/docs/guides/functions
3. Check Stripe webhook docs: https://stripe.com/docs/webhooks

## License

[Your License Here]
