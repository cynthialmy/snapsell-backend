import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

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
    // Get authorization header (optional for this endpoint)
    const authHeader = req.headers.get("Authorization");
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      authHeader
        ? {
            global: {
              headers: { Authorization: authHeader },
            },
          }
        : {}
    );

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
