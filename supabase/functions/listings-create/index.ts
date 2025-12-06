import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

interface CreateListingRequest {
  title: string;
  description?: string; // Made optional for migration compatibility
  price_cents?: number; // Made optional for migration compatibility
  currency?: string;
  condition?: string;
  category?: string;
  tags?: string[];
  storage_path: string;
  thumbnail_path?: string;
  ai_generated?: any;
  visibility?: "private" | "shared" | "public";
}

const FREE_LISTING_LIMIT = parseInt(Deno.env.get("FREE_LISTING_LIMIT") || "10", 10);

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Validate environment variables
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseSecretKey = Deno.env.get("SUPABASE_SECRET_KEY");
    const supabasePublishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

    if (!supabaseUrl || !supabaseSecretKey || !supabasePublishableKey) {
      const missing = [];
      if (!supabaseUrl) missing.push("SUPABASE_URL");
      if (!supabaseSecretKey) missing.push("SUPABASE_SECRET_KEY");
      if (!supabasePublishableKey) missing.push("SUPABASE_PUBLISHABLE_KEY");

      console.error("Missing environment variables:", {
        hasUrl: !!supabaseUrl,
        hasSecretKey: !!supabaseSecretKey,
        hasPublishableKey: !!supabasePublishableKey,
        missing,
      });
      return new Response(
        JSON.stringify({
          error: "Server configuration error",
          details: `Missing required environment variables: ${missing.join(", ")}. Please set these in Supabase Dashboard → Project Settings → Edge Functions → Secrets.`
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with secret key for admin operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey);

    const supabaseClient = createClient(supabaseUrl, supabasePublishableKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    // Get authenticated user
    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse request body
    let body: CreateListingRequest;
    try {
      body = await req.json();
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      return new Response(
        JSON.stringify({
          error: "Invalid JSON in request body",
          details: parseError instanceof Error ? parseError.message : String(parseError)
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate required fields
    if (!body.title || !body.storage_path) {
      return new Response(
        JSON.stringify({
          error: "title and storage_path are required",
          received: {
            hasTitle: !!body.title,
            hasStoragePath: !!body.storage_path,
            bodyKeys: Object.keys(body)
          }
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate data types
    if (body.price_cents !== undefined && typeof body.price_cents !== 'number') {
      return new Response(
        JSON.stringify({
          error: "price_cents must be a number",
          received: typeof body.price_cents,
          value: body.price_cents
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.tags !== undefined && !Array.isArray(body.tags)) {
      return new Response(
        JSON.stringify({
          error: "tags must be an array",
          received: typeof body.tags,
          value: body.tags
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check freemium quota
    const { data: quotaData, error: quotaError } = await supabaseAdmin.rpc(
      "check_free_quota",
      {
        p_user_id: user.id,
        p_free_limit: FREE_LISTING_LIMIT,
      }
    );

    if (quotaError) {
      console.error("Quota check error:", quotaError);
      return new Response(
        JSON.stringify({ error: "Failed to check quota", details: quotaError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const quota = quotaData?.[0];
    if (!quota) {
      return new Response(
        JSON.stringify({ error: "Failed to retrieve quota information" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if user has quota or credits
    if (!quota.has_quota) {
      // Get user profile to check credits
      const { data: profile } = await supabaseAdmin
        .from("users_profile")
        .select("credits, plan")
        .eq("id", user.id)
        .single();

      if (!profile || profile.credits <= 0) {
        return new Response(
          JSON.stringify({
            error: "Quota exceeded",
            code: "QUOTA_EXCEEDED",
            used: quota.used_count,
            limit: quota.limit_count,
            remaining: quota.remaining_count,
            message: "You've reached your free listing limit. Please upgrade or purchase credits.",
          }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // User has credits, deduct one
      const { error: deductError } = await supabaseAdmin.rpc("deduct_credit", {
        p_user_id: user.id,
        p_amount: 1,
      });

      if (deductError) {
        return new Response(
          JSON.stringify({ error: "Failed to deduct credit", details: deductError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Generate share_slug if visibility is shared or public
    let share_slug: string | null = null;
    if (body.visibility === "shared" || body.visibility === "public") {
      const { data: slugData, error: slugError } = await supabaseAdmin.rpc("generate_share_slug");
      if (slugError) {
        console.error("Slug generation error:", slugError);
        return new Response(
          JSON.stringify({ error: "Failed to generate share slug" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      share_slug = slugData;
    }

    // Prepare listing data with proper null handling
    const listingData: any = {
      user_id: user.id,
      title: body.title,
      storage_path: body.storage_path,
      currency: body.currency || "USD",
      visibility: body.visibility || "private",
    };

    // Only include optional fields if they are provided
    if (body.description !== undefined && body.description !== null) {
      listingData.description = body.description;
    }
    if (body.price_cents !== undefined && body.price_cents !== null) {
      listingData.price_cents = body.price_cents;
    }
    if (body.condition !== undefined && body.condition !== null) {
      listingData.condition = body.condition;
    }
    if (body.category !== undefined && body.category !== null) {
      listingData.category = body.category;
    }
    if (body.tags !== undefined && body.tags !== null) {
      listingData.tags = Array.isArray(body.tags) ? body.tags : [];
    }
    if (body.thumbnail_path !== undefined && body.thumbnail_path !== null) {
      listingData.thumbnail_path = body.thumbnail_path;
    }
    if (body.ai_generated !== undefined && body.ai_generated !== null) {
      listingData.ai_generated = body.ai_generated;
    }
    if (share_slug !== null) {
      listingData.share_slug = share_slug;
    }

    // Create listing
    const { data: listing, error: listingError } = await supabaseClient
      .from("listings")
      .insert(listingData)
      .select()
      .single();

    if (listingError) {
      console.error("Listing creation error:", listingError);
      console.error("Listing data attempted:", JSON.stringify(listingData, null, 2));
      return new Response(
        JSON.stringify({
          error: "Failed to create listing",
          details: listingError.message,
          code: listingError.code,
          hint: listingError.hint
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log usage
    await supabaseAdmin.from("usage_logs").insert({
      user_id: user.id,
      action: "create_listing",
      meta: { listing_id: listing.id },
    });

    return new Response(
      JSON.stringify({
        listing,
        quota: {
          used: quota.used_count + 1,
          limit: quota.limit_count,
          remaining: Math.max(0, quota.remaining_count - 1),
        },
      }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unhandled error:", error);
    console.error("Error stack:", error instanceof Error ? error.stack : "No stack trace");
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
        type: error instanceof Error ? error.constructor.name : typeof error
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
