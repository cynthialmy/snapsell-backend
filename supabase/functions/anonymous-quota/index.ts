import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const ANONYMOUS_DAILY_LIMIT = parseInt(Deno.env.get("ANONYMOUS_DAILY_LIMIT") || "10", 10);

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Use built-in Supabase environment variables
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

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Extract IP address from headers
    const forwardedFor = req.headers.get("x-forwarded-for");
    const realIp = req.headers.get("x-real-ip");
    const ipAddress = forwardedFor
      ? forwardedFor.split(",")[0].trim()
      : realIp || "unknown";

    // Get anonymous daily quota
    const { data: quotaData, error: quotaError } = await supabaseAdmin.rpc(
      "get_anonymous_daily_quota",
      {
        p_ip_address: ipAddress,
      }
    );

    if (quotaError) {
      console.error("Anonymous quota fetch error:", quotaError);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch quota",
          details: quotaError.message,
        }),
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

    return new Response(
      JSON.stringify({
        creations_used_today: quota.creations_used_today,
        creations_remaining_today: quota.creations_remaining_today,
        creations_daily_limit: quota.creations_daily_limit,
        resets_at: quota.reset_at,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
