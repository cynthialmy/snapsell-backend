#!/bin/bash

# Diagnostic script for Supabase Edge Functions
# Checks deployment status, logs, and configuration

set -e

echo "=========================================="
echo "Supabase Edge Functions Diagnostic Tool"
echo "=========================================="
echo ""

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    echo "❌ Supabase CLI is not installed"
    echo "   Install with: brew install supabase/tap/supabase"
    exit 1
fi

echo "✅ Supabase CLI found"
echo ""

# Check if logged in
echo "Checking Supabase login status..."
if ! supabase projects list &> /dev/null; then
    echo "❌ Not logged in to Supabase"
    echo "   Run: supabase login"
    exit 1
fi

echo "✅ Logged in to Supabase"
echo ""

# Get project ref - try multiple methods for compatibility (optional)
PROJECT_REF=""

# Method 1: Try from supabase status
if [ -z "$PROJECT_REF" ]; then
    PROJECT_REF=$(supabase status 2>/dev/null | grep "Project URL" | awk '{print $3}' | sed 's|https://||' | sed 's|.supabase.co||' | sed 's|/||g' || echo "")
fi

# Method 2: Try from .supabase/config.toml if it exists
if [ -z "$PROJECT_REF" ] && [ -f ".supabase/config.toml" ]; then
    PROJECT_REF=$(grep "project_id" .supabase/config.toml 2>/dev/null | sed 's/.*= *"\([^"]*\)".*/\1/' || echo "")
fi

# Project ref is optional for diagnostics - just show if we found it
if [ -n "$PROJECT_REF" ]; then
    echo "✅ Project ref: $PROJECT_REF"
    echo ""
else
    echo "ℹ️  Project ref not detected (not required for diagnostics)"
    echo ""
fi

# List deployed functions
echo "=========================================="
echo "1. Checking Deployed Functions"
echo "=========================================="
echo ""

FUNCTIONS=$(supabase functions list 2>&1)

if echo "$FUNCTIONS" | grep -q "upload"; then
    echo "✅ 'upload' function is deployed"
else
    echo "❌ 'upload' function is NOT deployed"
    echo "   Deploy with: supabase functions deploy upload"
fi

if echo "$FUNCTIONS" | grep -q "usage-check-quota"; then
    echo "✅ 'usage-check-quota' function is deployed"
else
    echo "❌ 'usage-check-quota' function is NOT deployed"
    echo "   Deploy with: supabase functions deploy usage-check-quota"
fi

echo ""
echo "All functions:"
echo "$FUNCTIONS"
echo ""

# Check function logs
echo "=========================================="
echo "2. Function Logs"
echo "=========================================="
echo ""

# Try to get logs (some Supabase CLI versions may not support this)
if supabase functions logs upload --limit 5 2>&1 | grep -q -v "Usage:"; then
    echo "Recent logs for 'upload' function:"
    supabase functions logs upload --limit 5 2>&1 | grep -v "Usage:" || true
else
    echo "ℹ️  Logs not available via CLI"
    echo "   View logs in Supabase Dashboard → Edge Functions → [function-name] → Logs"
fi

echo ""

if supabase functions logs usage-check-quota --limit 5 2>&1 | grep -q -v "Usage:"; then
    echo "Recent logs for 'usage-check-quota' function:"
    supabase functions logs usage-check-quota --limit 5 2>&1 | grep -v "Usage:" || true
else
    echo "ℹ️  Logs not available via CLI"
    echo "   View logs in Supabase Dashboard → Edge Functions → [function-name] → Logs"
fi

echo ""

# Check secrets
echo "=========================================="
echo "4. Checking Edge Function Secrets"
echo "=========================================="
echo ""

echo "Note: SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY"
echo "      are automatically provided by Supabase - you don't need to set them."
echo ""

SECRETS=$(supabase secrets list 2>&1)

if [ $? -eq 0 ]; then
    echo "Current secrets:"
    echo "$SECRETS"
    echo ""

    # Check for required secrets
    if echo "$SECRETS" | grep -q "FREE_LISTING_LIMIT"; then
        echo "✅ FREE_LISTING_LIMIT is set"
    else
        echo "⚠️  FREE_LISTING_LIMIT is not set (will default to 10)"
    fi
else
    echo "⚠️  Could not list secrets"
fi

echo ""

# Database function check
echo "=========================================="
echo "5. Database Function Check"
echo "=========================================="
echo ""

echo "Checking if 'check_free_quota' database function exists..."
echo "Run this SQL query in Supabase Dashboard → SQL Editor:"
echo ""
echo "SELECT proname FROM pg_proc WHERE proname = 'check_free_quota';"
echo ""
echo "If it returns no rows, run the migration:"
echo "  supabase db push"
echo ""

# Summary and recommendations
echo "=========================================="
echo "Summary & Recommendations"
echo "=========================================="
echo ""

echo "Common Issues & Fixes:"
echo ""
echo "1. Functions not deployed:"
echo "   → Deploy with: supabase functions deploy <function-name>"
echo ""
echo "2. Missing SUPABASE_SERVICE_ROLE_KEY:"
echo "   → This is automatically provided - no action needed"
echo "   → If still failing, check Supabase Dashboard → Project Settings → API"
echo ""
echo "3. Database function missing:"
echo "   → Run: supabase db push"
echo "   → Or apply migrations manually in Supabase Dashboard"
echo ""
echo "4. Storage bucket 'items' not created:"
echo "   → Check Supabase Dashboard → Storage"
echo "   → Create bucket 'items' if missing"
echo "   → Set it to private (not public)"
echo ""
