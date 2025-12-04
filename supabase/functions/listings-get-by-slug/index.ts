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

    // Create Supabase client (no auth required for public shares)
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SECRET_KEY") ?? ""
    );

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

    // Increment view counter (async, don't wait)
    const viewerIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null;
    supabaseAdmin.rpc("increment_listing_view", {
      p_listing_id: listing.id,
      p_viewer_ip: viewerIp ? viewerIp.split(",")[0].trim() : null,
      p_viewer_user_id: null, // Public views don't have user_id
    }).catch((err) => console.error("Failed to increment view:", err));

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
