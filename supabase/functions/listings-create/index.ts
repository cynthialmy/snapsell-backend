import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

interface CreateListingRequest {
  title: string;
  description: string;
  price_cents: number;
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
    // Get authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with service role for admin operations
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    );

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
    const body: CreateListingRequest = await req.json();

    // Validate required fields
    if (!body.title || !body.storage_path) {
      return new Response(
        JSON.stringify({ error: "title and storage_path are required" }),
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

    // Create listing
    const { data: listing, error: listingError } = await supabaseClient
      .from("listings")
      .insert({
        user_id: user.id,
        title: body.title,
        description: body.description,
        price_cents: body.price_cents,
        currency: body.currency || "USD",
        condition: body.condition,
        category: body.category,
        tags: body.tags || [],
        storage_path: body.storage_path,
        thumbnail_path: body.thumbnail_path,
        ai_generated: body.ai_generated,
        visibility: body.visibility || "private",
        share_slug,
      })
      .select()
      .single();

    if (listingError) {
      console.error("Listing creation error:", listingError);
      return new Response(
        JSON.stringify({ error: "Failed to create listing", details: listingError.message }),
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
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
