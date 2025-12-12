import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Only allow POST requests
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get authentication (require service role or admin)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify this is a service role request (for security)
    if (!authHeader.includes(supabaseServiceRoleKey)) {
      return new Response(
        JSON.stringify({ error: "Unauthorized - service role required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Parse request body
    const body = await req.json().catch(() => ({}));
    const sessionId = body.session_id; // Optional: fix specific payment
    const fixAll = body.fix_all === true; // Optional: fix all missing credits

    if (sessionId) {
      // Fix specific payment
      const { data, error } = await supabaseAdmin.rpc("fix_missing_credits_for_payment", {
        p_session_id: sessionId,
        p_credits: body.credits || null,
      });

      if (error) {
        console.error("Error fixing payment:", error);
        return new Response(
          JSON.stringify({ error: "Failed to fix payment", details: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify(data),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else if (fixAll) {
      // Fix all payments with missing credits
      const { data, error } = await supabaseAdmin.rpc("fix_missing_credits_for_payments");

      if (error) {
        console.error("Error fixing payments:", error);
        return new Response(
          JSON.stringify({ error: "Failed to fix payments", details: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const results = data || [];
      const successCount = results.filter((r: any) => r.success).length;
      const failCount = results.filter((r: any) => !r.success).length;
      const totalCreditsAdded = results.reduce((sum: number, r: any) => sum + (r.credits_added || 0), 0);

      return new Response(
        JSON.stringify({
          success: true,
          processed: results.length,
          successful: successCount,
          failed: failCount,
          total_credits_added: totalCreditsAdded,
          results: results,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      return new Response(
        JSON.stringify({
          error: "Missing parameter",
          message: "Provide either 'session_id' or 'fix_all: true' in request body"
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (error) {
    console.error("Fix missing credits error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});





