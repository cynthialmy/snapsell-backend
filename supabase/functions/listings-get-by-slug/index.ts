import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Extract slug from URL path
    const url = new URL(req.url);
    const pathParts = url.pathname.split("/");
    const slug = pathParts[pathParts.length - 1];

    if (!slug) {
      return new Response(
        JSON.stringify({ error: "Share slug is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use built-in Supabase environment variables (automatically available in Edge Functions)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({
          error: "Server configuration error",
          details: "Supabase environment variables are not available."
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client (no auth required for public shares)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Get listing by slug
    const { data: listing, error: listingError } = await supabaseAdmin
      .from("listings")
      .select(`
        id,
        title,
        description,
        price_cents,
        currency,
        condition,
        category,
        tags,
        storage_path,
        thumbnail_path,
        ai_generated,
        visibility,
        share_slug,
        created_at
      `)
      .eq("share_slug", slug)
      .in("visibility", ["shared", "public"])
      .single();

    if (listingError || !listing) {
      return new Response(
        JSON.stringify({ error: "Listing not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate signed URLs for images
    let imageUrl: string | null = null;
    let thumbnailUrl: string | null = null;

    if (listing.storage_path) {
      const { data: urlData } = await supabaseAdmin.storage
        .from("items")
        .createSignedUrl(listing.storage_path, 3600);
      imageUrl = urlData?.signedUrl || null;
    }

    if (listing.thumbnail_path) {
      const { data: thumbData } = await supabaseAdmin.storage
        .from("items")
        .createSignedUrl(listing.thumbnail_path, 3600);
      thumbnailUrl = thumbData?.signedUrl || null;
    }

    // Increment view counter with rate limiting (async, don't wait)
    const viewerIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null;
    const ipAddress = viewerIp ? viewerIp.split(",")[0].trim() : null;

    if (ipAddress) {
      // Check rate limit before incrementing (1 view per IP per hour per listing)
      supabaseAdmin.rpc("check_view_increment_rate_limit", {
        p_listing_id: listing.id,
        p_viewer_ip: ipAddress,
      }).then(({ data: allowed, error: rateLimitError }) => {
        if (rateLimitError) {
          console.error("Rate limit check error:", rateLimitError);
          // On error, allow the increment (fail open)
          return supabaseAdmin.rpc("increment_listing_view", {
            p_listing_id: listing.id,
            p_viewer_ip: ipAddress,
            p_viewer_user_id: null,
          }).catch((err) => console.error("Failed to increment view:", err));
        }

        // Only increment if rate limit allows (data is the boolean return value)
        if (allowed === true) {
          return supabaseAdmin.rpc("increment_listing_view", {
            p_listing_id: listing.id,
            p_viewer_ip: ipAddress,
            p_viewer_user_id: null, // Public views don't have user_id
          }).catch((err) => console.error("Failed to increment view:", err));
        } else {
          // Rate limited - view not counted
          console.log(`View increment rate limited for listing ${listing.id} from IP ${ipAddress}`);
        }
      }).catch((err) => console.error("Rate limit check failed:", err));
    } else {
      // If no IP, still try to increment (for edge cases)
      supabaseAdmin.rpc("increment_listing_view", {
        p_listing_id: listing.id,
        p_viewer_ip: null,
        p_viewer_user_id: null,
      }).catch((err) => console.error("Failed to increment view:", err));
    }

    // Return listing without PII
    return new Response(
      JSON.stringify({
        ...listing,
        image_url: imageUrl,
        thumbnail_url: thumbnailUrl,
        // Explicitly exclude user_id from response
        user_id: undefined,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
