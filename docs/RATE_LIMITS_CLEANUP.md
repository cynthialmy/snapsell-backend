# Rate Limits Cleanup

This document describes how to set up and monitor the automatic cleanup of old rate limit records.

## Overview

The `rate_limits` table tracks API rate limit usage to prevent abuse. Over time, this table can grow large, so we need to periodically clean up old records.

The cleanup function `clean_old_rate_limits()` removes all rate limit records older than 24 hours.

## Automatic Cleanup (Recommended)

### Using pg_cron (PostgreSQL Extension)

The migration `20240101000005_rate_limits_cron.sql` sets up automatic cleanup using `pg_cron`:

- **Weekly job**: Runs every Sunday at 2:00 AM UTC
- **Daily backup job**: Runs every day at 3:00 AM UTC (as a safety net)

#### Setup

1. **Apply the migration:**
   ```bash
   supabase db push
   ```

2. **Verify pg_cron is enabled:**
   ```sql
   SELECT * FROM pg_extension WHERE extname = 'pg_cron';
   ```

3. **If pg_cron is not available:**
   - For **Supabase Cloud**: Contact Supabase support to enable `pg_cron` extension
   - For **Self-hosted Supabase**: `pg_cron` should be available by default

#### Monitoring

**View scheduled jobs:**
```sql
SELECT * FROM cron.job;
```

**View job execution history:**
```sql
SELECT * FROM cron.job_run_details
WHERE jobname IN ('clean-old-rate-limits-weekly', 'clean-old-rate-limits-daily')
ORDER BY start_time DESC
LIMIT 20;
```

**Check table size:**
```sql
SELECT
  COUNT(*) as total_records,
  COUNT(DISTINCT identifier) as unique_identifiers,
  COUNT(DISTINCT endpoint) as unique_endpoints,
  MIN(window_start) as oldest_record,
  MAX(window_start) as newest_record
FROM public.rate_limits;
```

**Check records pending cleanup:**
```sql
SELECT COUNT(*) as records_to_clean
FROM public.rate_limits
WHERE window_start < NOW() - INTERVAL '24 hours';
```

## Alternative: External Cron Service

If `pg_cron` is not available, you can use an external cron service to call the cleanup function.

### Option 1: Supabase Edge Function + External Cron

1. **Create a cleanup Edge Function** (optional - you can call the function directly via SQL):
   ```typescript
   // supabase/functions/cleanup-rate-limits/index.ts
   import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
   import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

   serve(async (req) => {
     const supabaseUrl = Deno.env.get("SUPABASE_URL");
     const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

     if (!supabaseUrl || !supabaseServiceRoleKey) {
       return new Response(JSON.stringify({ error: "Missing config" }), { status: 500 });
     }

     const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
     const { data, error } = await supabase.rpc("clean_old_rate_limits");

     if (error) {
       return new Response(JSON.stringify({ error: error.message }), { status: 500 });
     }

     return new Response(JSON.stringify({ deleted: data }), { status: 200 });
   });
   ```

2. **Set up external cron** (e.g., using GitHub Actions, cron-job.org, or similar):
   - **Weekly**: Call the function every Sunday at 2:00 AM UTC
   - **URL**: `https://your-project.supabase.co/functions/v1/cleanup-rate-limits`
   - **Headers**: `Authorization: Bearer YOUR_SERVICE_ROLE_KEY`

### Option 2: Direct SQL via External Cron

Use a service that can execute SQL queries (e.g., a scheduled script):

```sql
SELECT public.clean_old_rate_limits();
```

## Manual Cleanup

You can manually run the cleanup function at any time:

```sql
SELECT public.clean_old_rate_limits();
```

This returns the number of records deleted.

## Troubleshooting

### pg_cron Extension Not Available

If you see an error like `extension "pg_cron" does not exist`:

1. **Supabase Cloud**: Contact Supabase support to enable the extension
2. **Self-hosted**: Install and enable `pg_cron` in your PostgreSQL instance

### Cron Jobs Not Running

1. Check if jobs are scheduled:
   ```sql
   SELECT * FROM cron.job;
   ```

2. Check job execution history:
   ```sql
   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
   ```

3. Verify the function exists:
   ```sql
   SELECT proname FROM pg_proc WHERE proname = 'clean_old_rate_limits';
   ```

### Table Growing Too Large

If the `rate_limits` table is growing too large despite cleanup:

1. **Check cleanup is running**: Verify cron jobs are executing successfully
2. **Reduce retention period**: Modify the function to delete records older than 12 hours instead of 24 hours
3. **Run manual cleanup**: Execute `SELECT public.clean_old_rate_limits();` manually

## Performance Considerations

- The cleanup function uses an index on `window_start` for efficient deletion
- Cleanup typically takes < 1 second for tables with millions of records
- The function uses `SECURITY DEFINER` so it can delete records regardless of RLS policies

## Maintenance

- **Weekly**: Review cron job execution logs
- **Monthly**: Check table size and cleanup effectiveness
- **Quarterly**: Review and adjust retention period if needed
