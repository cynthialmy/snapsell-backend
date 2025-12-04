import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

interface FeedbackRequest {
  type: "app" | "listing";
  listing_id?: string;
  rating?: number;
  comment: string;
  attachment?: string; // Base64 encoded
  attachment_filename?: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get authorization header (optional for anonymous feedback)
    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
      authHeader
        ? {
            global: {
              headers: { Authorization: authHeader },
            },
          }
        : {}
    );

    // Try to get user if authenticated
    if (authHeader) {
      const {
        data: { user },
      } = await supabaseClient.auth.getUser();
      userId = user?.id || null;
    }

    // Parse request body
    const body: FeedbackRequest = await req.json();

    // Validate required fields
    if (!body.type || !body.comment) {
      return new Response(
        JSON.stringify({ error: "type and comment are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.type === "listing" && !body.listing_id) {
      return new Response(
        JSON.stringify({ error: "listing_id is required for listing feedback" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.rating && (body.rating < 1 || body.rating > 5)) {
      return new Response(
        JSON.stringify({ error: "rating must be between 1 and 5" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle attachment upload if provided
    let attachmentPath: string | null = null;
    if (body.attachment && body.attachment_filename) {
      const supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SECRET_KEY") ?? ""
      );

      const folder = userId ? `feedback/${userId}` : "feedback/anonymous";
      const fileName = `${crypto.randomUUID()}_${body.attachment_filename}`;
      const filePath = `${folder}/${fileName}`;

      // Decode base64
      const base64Data = body.attachment.replace(/^data:.*;base64,/, "");
      const binaryData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

      const { error: uploadError } = await supabaseAdmin.storage
        .from("items")
        .upload(filePath, binaryData, {
          contentType: "image/jpeg", // Default, adjust if needed
          upsert: false,
        });

      if (uploadError) {
        console.error("Attachment upload error:", uploadError);
        // Continue without attachment if upload fails
      } else {
        attachmentPath = filePath;
      }
    }

    // Create feedback record
    const { data: feedback, error: feedbackError } = await supabaseClient
      .from("feedback")
      .insert({
        user_id: userId,
        type: body.type,
        listing_id: body.listing_id || null,
        rating: body.rating || null,
        comment: body.comment,
        attachment_path: attachmentPath,
      })
      .select()
      .single();

    if (feedbackError) {
      console.error("Feedback creation error:", feedbackError);
      return new Response(
        JSON.stringify({ error: "Failed to create feedback", details: feedbackError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ feedback }),
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
