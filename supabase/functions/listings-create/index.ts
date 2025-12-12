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

// Removed FREE_LISTING_LIMIT - now using save_slots_remaining from user_quota table

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use built-in Supabase environment variables (automatically available in Edge Functions)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
      console.error("Missing Supabase environment variables:", {
        hasUrl: !!supabaseUrl,
        hasServiceRoleKey: !!supabaseServiceRoleKey,
        hasAnonKey: !!supabaseAnonKey,
      });
      return new Response(
        JSON.stringify({
          error: "Server configuration error",
          details: "Supabase environment variables are not available. This should not happen in Edge Functions."
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with service role key for admin operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
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

    // NOTE: Creation quota is NOT decremented here - it's decremented when /analyze-image is called
    // This endpoint only decrements save slots (for storing the listing)
    // Each generation/analysis consumes creation quota, saving the listing consumes save slots

    // Check save slots quota
    const { data: slotsDecremented, error: slotsError } = await supabaseAdmin.rpc(
      "decrement_save_slots",
      {
        p_user_id: user.id,
        p_amount: 1,
      }
    );

    if (slotsError) {
      console.error("Save slots check error:", slotsError);
      // Note: Creation quota already decremented, but save slots failed
      // This is a rare edge case - log it for monitoring
      console.error("WARNING: Creation quota decremented but save slots check failed. User:", user.id);
      return new Response(
        JSON.stringify({ error: "Failed to check save slots", details: slotsError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!slotsDecremented) {
      // Get quota info for error message
      const { data: quotaData } = await supabaseAdmin.rpc("get_user_quota", {
        p_user_id: user.id,
      });
      const quota = quotaData?.[0];

      // Track analytics (non-blocking)
      supabaseAdmin.from("usage_logs").insert({
        user_id: user.id,
        action: "create_listing",
        meta: { blocked: true, reason: "save_slots_exceeded" },
      }).then(({ error }) => {
        if (error) console.error("Analytics error:", error);
      });

      // Note: Creation quota already decremented, but save slots exceeded
      // This is a rare edge case - log it for monitoring
      console.error("WARNING: Creation quota decremented but save slots exceeded. User:", user.id);

      return new Response(
        JSON.stringify({
          error: "Save slots exceeded",
          code: "SAVE_SLOTS_EXCEEDED",
          save_slots_remaining: quota?.save_slots_remaining || 0,
          message: "You've reached your save slots limit. Purchase a pack to continue.",
          purchase_url: "/purchases",
        }),
        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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

    // Get updated quota info after successful listing creation
    // Note: Creation quota was already decremented in /analyze-image, only save slots were decremented here
    const { data: quotaData, error: quotaFetchError } = await supabaseAdmin.rpc("get_user_quota", {
      p_user_id: user.id,
    });

    if (quotaFetchError) {
      console.error("[Listings-Create] Error fetching updated quota:", JSON.stringify(quotaFetchError, null, 2));
    }

    const quota = quotaData?.[0];

    console.log("[Listings-Create] Quota after listing creation (save slots decremented):", {
      user_id: user.id,
      creations_remaining_today: quota?.creations_remaining_today,
      bonus_creations_remaining: quota?.bonus_creations_remaining,
      save_slots_remaining: quota?.save_slots_remaining,
    });

    // Log usage (non-blocking)
    supabaseAdmin.from("usage_logs").insert({
      user_id: user.id,
      action: "create_listing",
      meta: { listing_id: listing.id },
    }).then(({ error }) => {
      if (error) console.error("Analytics error:", error);
    });

    return new Response(
      JSON.stringify({
        listing,
        quota: {
          creations_remaining_today: quota?.creations_remaining_today ?? 0,
          creations_daily_limit: 10, // Default daily limit for free users
          bonus_creations_remaining: quota?.bonus_creations_remaining ?? 0,
          save_slots_remaining: quota?.save_slots_remaining ?? 0,
          is_pro: quota?.is_pro ?? false,
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
