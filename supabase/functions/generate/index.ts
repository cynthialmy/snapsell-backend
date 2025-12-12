import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  checkRateLimit,
  getRateLimitIdentifier,
  createRateLimitErrorResponse,
} from "../_shared/rate-limit.ts";

interface GenerateRequest {
  storage_path: string;
  // Optional: vision API config
  vision_api_key?: string;
  llm_api_key?: string;
}

// TODO: Replace with actual vision + LLM API calls
// This is a stub implementation for v1
async function callVisionAPI(imageUrl: string): Promise<any> {
  // Stub: Return mock vision analysis
  // In production, call your vision API (e.g., OpenAI Vision, Google Vision)
  return {
    objects: ["furniture", "chair"],
    colors: ["brown", "wood"],
    condition: "good",
  };
}

// TODO: Replace with actual LLM API call
// This is a stub implementation for v1
async function callLLMAPI(visionData: any, imageUrl: string): Promise<any> {
  // Stub: Return mock LLM-generated content
  // In production, call your LLM API (e.g., OpenAI GPT-4, Anthropic Claude)
  return {
    title: "Vintage Wooden Chair",
    description: "Beautiful vintage wooden chair in excellent condition. Perfect for dining room or kitchen. Solid construction with comfortable seating.",
    price_suggestion: 75,
    condition: "Good",
    category: "Furniture",
    tags: ["vintage", "wood", "chair", "dining"],
  };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Use built-in Supabase environment variables (automatically available in Edge Functions)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
      return new Response(
        JSON.stringify({
          error: "Server configuration error",
          details: "Supabase environment variables are not available."
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Get authorization header (optional for this endpoint)
    const authHeader = req.headers.get("Authorization");
    const idempotencyKey = req.headers.get("Idempotency-Key");
    const supabaseClient = createClient(
      supabaseUrl,
      supabaseAnonKey,
      authHeader
        ? {
          global: {
            headers: { Authorization: authHeader },
          },
        }
        : {}
    );

    // Get authenticated user (if present)
    let user: any = null;
    if (authHeader) {
      const {
        data: { user: authUser },
        error: userError,
      } = await supabaseClient.auth.getUser();
      if (!userError && authUser) {
        user = authUser;
      }
    }

    // Rate limiting: Always enforce IP-based rate limit (60/min)
    const identifier = getRateLimitIdentifier(req, user?.id);
    const rateLimitResult = await checkRateLimit(
      supabaseAdmin,
      identifier,
      "generate",
      60,
      1 // 60 requests per minute
    );

    if (!rateLimitResult.allowed) {
      return createRateLimitErrorResponse(rateLimitResult, corsHeaders);
    }

    // If not authenticated, check anonymous daily creation limit
    if (!user) {
      const forwardedFor = req.headers.get("x-forwarded-for");
      const realIp = req.headers.get("x-real-ip");
      const ipAddress = forwardedFor
        ? forwardedFor.split(",")[0].trim()
        : realIp || "unknown";

      const { data: dailyLimitCheck, error: dailyLimitError } = await supabaseAdmin.rpc(
        "check_anonymous_daily_creation_limit",
        {
          p_ip_address: ipAddress,
          p_daily_limit: 10,
        }
      );

      if (dailyLimitError) {
        console.error("Anonymous daily limit check error:", dailyLimitError);
        // Fail open - allow the request but log the error
      } else if (dailyLimitCheck === false) {
        // Get quota info for error message
        const { data: quotaData } = await supabaseAdmin.rpc("get_anonymous_daily_quota", {
          p_ip_address: ipAddress,
        });
        const quota = quotaData?.[0];

        return new Response(
          JSON.stringify({
            error: "Daily creation limit exceeded",
            code: "ANONYMOUS_DAILY_LIMIT_EXCEEDED",
            message: "You've reached your daily creation limit. Sign in for higher limits or try again tomorrow.",
            creations_remaining_today: quota?.creations_remaining_today || 0,
            creations_daily_limit: quota?.creations_daily_limit || 10,
            resets_at: quota?.reset_at,
          }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Track the creation in rate_limits for daily tracking (using daily window)
      // This ensures the creation is counted toward the daily limit
      const dailyIdentifier = `ip:${ipAddress}`;

      // Use rate limit tracking with 1440 minute window (24 hours) for daily tracking
      // This will increment the count in rate_limits table for daily tracking
      // IMPORTANT: Check the result - if rate limit exceeded, reject the request
      const rateLimitResult = await checkRateLimit(
        supabaseAdmin,
        dailyIdentifier,
        "generate",
        10, // Daily limit
        1440 // 24 hours in minutes
      );

      if (!rateLimitResult.allowed) {
        return createRateLimitErrorResponse(rateLimitResult, corsHeaders);
      }
    }

    // If authenticated, check quota
    if (user) {
      const { data: quotaDecremented, error: quotaError } = await supabaseAdmin.rpc(
        "decrement_creation_quota",
        {
          p_user_id: user.id,
          p_amount: 1,
        }
      );

      if (quotaError) {
        console.error("Quota decrement error:", quotaError);
        return new Response(
          JSON.stringify({
            error: "Failed to check quota",
            details: quotaError.message,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!quotaDecremented) {
        // Track analytics (non-blocking)
        supabaseAdmin.from("usage_logs").insert({
          user_id: user.id,
          action: "generate_copy",
          meta: { blocked: true, reason: "quota_exceeded" },
        }).then(({ error }) => {
          if (error) console.error("Analytics error:", error);
        });

        // Get quota info for error message
        const { data: quotaData } = await supabaseAdmin.rpc("get_user_quota", {
          p_user_id: user.id,
        });
        const quota = quotaData?.[0];

        return new Response(
          JSON.stringify({
            error: "Quota exceeded",
            code: "QUOTA_EXCEEDED",
            message: "You've reached your daily creation limit. Purchase a pack to continue.",
            creations_remaining_today: quota?.creations_remaining_today || 0,
            bonus_creations_remaining: quota?.bonus_creations_remaining || 0,
            purchase_url: "/purchases",
          }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Parse request body
    const body: GenerateRequest = await req.json();

    if (!body.storage_path) {
      return new Response(
        JSON.stringify({ error: "storage_path is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get signed URL for the image
    const { data: urlData, error: urlError } = await supabaseClient.storage
      .from("items")
      .createSignedUrl(body.storage_path, 3600);

    if (urlError || !urlData) {
      return new Response(
        JSON.stringify({ error: "Failed to generate image URL", details: urlError?.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 1: Call Vision API (stubbed)
    const visionData = await callVisionAPI(urlData.signedUrl);

    // Step 2: Call LLM API (stubbed)
    const llmData = await callLLMAPI(visionData, urlData.signedUrl);

    // Structure the response
    const ai_generated = {
      vision_analysis: visionData,
      llm_generation: llmData,
      generated_at: new Date().toISOString(),
    };

    // Track analytics (non-blocking)
    if (user) {
      supabaseAdmin.from("usage_logs").insert({
        user_id: user.id,
        action: "generate_copy",
        meta: { storage_path: body.storage_path },
      }).then(({ error }) => {
        if (error) console.error("Analytics error:", error);
      });
    }

    return new Response(
      JSON.stringify({
        ai_generated,
        title: llmData.title,
        description: llmData.description,
        price_cents: llmData.price_suggestion * 100, // Convert to cents
        currency: "USD",
        condition: llmData.condition,
        category: llmData.category,
        tags: llmData.tags,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-RateLimit-Limit": rateLimitResult.limit.toString(),
          "X-RateLimit-Remaining": rateLimitResult.remaining.toString(),
          "X-RateLimit-Reset": Math.floor(rateLimitResult.resetAt.getTime() / 1000).toString(),
        },
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
