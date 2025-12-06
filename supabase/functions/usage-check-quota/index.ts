import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

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
          debug: {
            hasUrl: !!supabaseUrl,
            hasServiceRoleKey: !!supabaseServiceRoleKey,
            hasAnonKey: !!supabaseAnonKey,
          }
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase clients
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

    // Get user profile
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("users_profile")
      .select("plan, credits")
      .eq("id", user.id)
      .single();

    if (profileError) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch user profile", details: profileError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check quota
    const { data: quotaData, error: quotaError } = await supabaseAdmin.rpc(
      "check_free_quota",
      {
        p_user_id: user.id,
        p_free_limit: FREE_LISTING_LIMIT,
      }
    );

    if (quotaError) {
      console.error("Quota check error:", quotaError);
      console.error("Error details:", {
        code: quotaError.code,
        message: quotaError.message,
        details: quotaError.details,
        hint: quotaError.hint,
      });
      return new Response(
        JSON.stringify({
          error: "Failed to check quota",
          details: quotaError.message,
          hint: quotaError.hint || "The check_free_quota database function may not exist. Run migrations: supabase db push"
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
        used: quota.used_count,
        limit: quota.limit_count,
        remaining: quota.remaining_count,
        hasCredits: (profile?.credits || 0) > 0,
        credits: profile?.credits || 0,
        plan: profile?.plan || "free",
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
