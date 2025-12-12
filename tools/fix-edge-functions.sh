#!/bin/bash

# Fix script for Supabase Edge Functions
# Deploys functions and verifies configuration

set -e

echo "=========================================="
echo "Supabase Edge Functions Fix Script"
echo "=========================================="
echo ""

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    echo "❌ Supabase CLI is not installed"
    echo "   Install with: brew install supabase/tap/supabase"
    exit 1
fi

# Check if logged in
if ! supabase projects list &> /dev/null; then
    echo "❌ Not logged in to Supabase"
    echo "   Run: supabase login"
    exit 1
fi

# Get project directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
FUNCTIONS_DIR="$PROJECT_DIR/supabase/functions"

echo "Project directory: $PROJECT_DIR"
echo "Functions directory: $FUNCTIONS_DIR"
echo ""

# Step 1: Deploy upload function
echo "=========================================="
echo "Step 1: Deploying 'upload' function"
echo "=========================================="
echo ""

if [ -d "$FUNCTIONS_DIR/upload" ]; then
    echo "Deploying upload function..."
    cd "$PROJECT_DIR"
    supabase functions deploy upload || {
        echo "❌ Failed to deploy upload function"
        echo "   Check the error above and try again"
        exit 1
    }
    echo "✅ Upload function deployed successfully"
else
    echo "❌ Upload function directory not found at $FUNCTIONS_DIR/upload"
    exit 1
fi

echo ""

# Step 2: Deploy usage-check-quota function
echo "=========================================="
echo "Step 2: Deploying 'usage-check-quota' function"
echo "=========================================="
echo ""

if [ -d "$FUNCTIONS_DIR/usage-check-quota" ]; then
    echo "Deploying usage-check-quota function..."
    cd "$PROJECT_DIR"
    supabase functions deploy usage-check-quota || {
        echo "❌ Failed to deploy usage-check-quota function"
        echo "   Check the error above and try again"
        exit 1
    }
    echo "✅ Usage-check-quota function deployed successfully"
else
    echo "❌ Usage-check-quota function directory not found at $FUNCTIONS_DIR/usage-check-quota"
    exit 1
fi

echo ""

# Step 3: Verify database migrations
echo "=========================================="
echo "Step 3: Verifying Database Migrations"
echo "=========================================="
echo ""

echo "Checking if migrations need to be applied..."
echo "Run this command to apply migrations:"
echo "  supabase db push"
echo ""
echo "Or apply them manually in Supabase Dashboard → SQL Editor"
echo ""

# Step 4: Check storage bucket
echo "=========================================="
echo "Step 4: Storage Bucket Check"
echo "=========================================="
echo ""

echo "Verify the 'items' storage bucket exists:"
echo "1. Go to Supabase Dashboard → Storage"
echo "2. Check if 'items' bucket exists"
echo "3. If not, create it with:"
echo "   - Name: items"
echo "   - Public: No (private)"
echo "   - File size limit: 10MB"
echo "   - Allowed MIME types: image/jpeg, image/jpg, image/png, image/webp"
echo ""

# Step 5: Verify secrets (optional)
echo "=========================================="
echo "Step 5: Optional Secrets Configuration"
echo "=========================================="
echo ""

echo "The following secrets are optional:"
echo "  - FREE_LISTING_LIMIT (defaults to 10 if not set)"
echo ""
echo "To set secrets, use:"
echo "  supabase secrets set FREE_LISTING_LIMIT=10"
echo ""
echo "Or set them in Supabase Dashboard → Edge Functions → Secrets"
echo ""

# Summary
echo "=========================================="
echo "Summary"
echo "=========================================="
echo ""

echo "✅ Functions deployed:"
echo "   - upload"
echo "   - usage-check-quota"
echo ""
echo "⚠️  Next steps:"
echo "   1. Verify database migrations are applied (supabase db push)"
echo "   2. Verify 'items' storage bucket exists and is configured correctly"
echo "   3. Test the functions from your app"
echo ""
echo "To check function logs:"
echo "  supabase functions logs upload"
echo "  supabase functions logs usage-check-quota"
echo ""










