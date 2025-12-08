import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

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
          details: "Supabase environment variables are not available. This should not happen in Edge Functions.",
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

    // Get user's listings with view count
    // Use a query that joins with listing_views to compute view_count
    const { data: listings, error: listingsError } = await supabaseAdmin
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
        visibility,
        share_slug,
        created_at,
        updated_at
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (listingsError) {
      console.error("Listings query error:", listingsError);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch listings",
          details: listingsError.message,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Compute view_count for each listing and generate signed URLs
    const listingsWithViews = await Promise.all(
      (listings || []).map(async (listing) => {
        // Get view count from listing_views table
        const { count: viewCount, error: viewCountError } = await supabaseAdmin
          .from("listing_views")
          .select("*", { count: "exact", head: true })
          .eq("listing_id", listing.id);

        if (viewCountError) {
          console.error(`View count error for listing ${listing.id}:`, viewCountError);
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

        return {
          id: listing.id,
          title: listing.title,
          description: listing.description,
          price_cents: listing.price_cents,
          currency: listing.currency,
          condition: listing.condition,
          category: listing.category,
          tags: listing.tags,
          image_url: imageUrl,
          thumbnail_url: thumbnailUrl,
          view_count: viewCount || 0,
          created_at: listing.created_at,
          updated_at: listing.updated_at,
          share_slug: listing.share_slug,
          visibility: listing.visibility,
        };
      })
    );

    return new Response(
      JSON.stringify({ listings: listingsWithViews }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unhandled error:", error);
    console.error("Error stack:", error instanceof Error ? error.stack : "No stack trace");
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
        type: error instanceof Error ? error.constructor.name : typeof error,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
