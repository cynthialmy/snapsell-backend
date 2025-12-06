/**
 * Supabase Edge Function: analyze-image
 *
 * Analyzes product images using LLM vision models to generate structured listing data.
 * Supports multiple LLM providers: OpenAI, Azure OpenAI, Anthropic, Gemini, DeepSeek, SiliconFlow.
 *
 * Endpoint: POST /functions/v1/analyze-image
 * Content-Type: multipart/form-data
 *
 * Request fields:
 * - image (file, required): Image file (JPEG, PNG, etc.)
 * - provider (string, optional): LLM provider name (default: "azure")
 * - model (string, optional): Specific model to use (default: provider-specific)
 * - currency (string, optional): Currency code for price estimation (e.g., "USD", "EUR")
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import OpenAI from "https://esm.sh/openai@4.0.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.18.0";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.3.0";
import { corsHeaders } from "../_shared/cors.ts";

// ============================================
// Types
// ============================================

interface ListingData {
  title: string;
  price: string;
  description: string;
  condition: string;
  location: string;
  brand?: string;
  pickupAvailable?: boolean;
  shippingAvailable?: boolean;
  pickupNotes?: string;
}

type LLMProvider = "openai" | "azure" | "anthropic" | "gemini" | "deepseek" | "siliconflow";

// ============================================
// Environment Variables
// ============================================

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_BASE_URL = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL_DEPLOYMENT") || "gpt-4o";

const AZURE_OPENAI_API_KEY = Deno.env.get("AZURE_OPENAI_API_KEY");
const AZURE_OPENAI_ENDPOINT = Deno.env.get("AZURE_OPENAI_ENDPOINT");
const AZURE_OPENAI_API_VERSION = Deno.env.get("AZURE_OPENAI_API_VERSION") || "2024-08-01-preview";
const AZURE_OPENAI_MODEL = Deno.env.get("AZURE_OPENAI_MODEL_DEPLOYMENT") || "gpt-4o-ms";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ANTHROPIC_MODEL = "claude-3-7-sonnet-20250219";

const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY");
const GOOGLE_MODEL = "gemini-2.0-flash-exp";

const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY");
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL = "deepseek-chat";

const SILICONFLOW_API_KEY = Deno.env.get("SILICONFLOW_API_KEY");
const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
const SILICONFLOW_MODEL = "deepseek-ai/DeepSeek-R1";

const POSTHOG_API_KEY = Deno.env.get("POSTHOG_API_KEY");
const POSTHOG_HOST = Deno.env.get("POSTHOG_HOST");

// ============================================
// Helper Functions
// ============================================

function buildPromptTemplate(currency?: string): string {
  const currencyContext = currency
    ? `\n- Estimate price in ${currency} based on the item's condition, brand, age, and market value. Use realistic pricing appropriate for ${currency} (e.g., a used chair might be 45-150 ${currency}, a new phone might be 500-1200 ${currency}). If you cannot reasonably estimate the price, return an empty string. Do NOT use placeholder values like 120.`
    : `\n- Estimate price based on the item's condition, brand, age, and market value. Use realistic pricing (e.g., a used chair might be 45-150, a new phone might be 500-1200). If you cannot reasonably estimate the price, return an empty string. Do NOT use placeholder values like 120.`;

  return `You are SnapSell, an assistant that helps people list second-hand items.

Analyze the attached product photo and return ONLY valid JSON (no markdown, no code blocks, no explanations) matching this exact schema:

{
  "title": string,          // short, searchable product headline
  "price": string,          // numeric price, no currency symbol
  "description": string,    // 2-3 concise sentences with key selling points
  "condition": string,      // one of: "New", "Used - Like New", "Used - Good", "Used - Fair", "Refurbished"
  "location": string        // city or neighborhood if inferable, otherwise empty string
}

Rules:
- Return ONLY the JSON object, nothing else. No markdown code blocks, no explanations, no text before or after.${currencyContext}
- Keep description under 400 characters.
- Prefer realistic consumer-friendly language.
- If you cannot infer a field, return an empty string for that field.`;
}

function normalizeListing(payload: any): ListingData {
  const toBool = (value: any): boolean => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Boolean(value);
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "y"].includes(normalized)) return true;
      if (["0", "false", "no", "n"].includes(normalized)) return false;
    }
    return false;
  };

  return {
    title: payload.title || "",
    price: String(payload.price || ""),
    description: payload.description || "",
    condition: payload.condition || "",
    location: payload.location || "",
    brand: payload.brand || "",
    pickupAvailable: toBool(payload.pickupAvailable),
    shippingAvailable: toBool(payload.shippingAvailable),
    pickupNotes: payload.pickupNotes || "",
  };
}

function extractJsonFromResponse(response: string): string {
  let jsonText = response.trim();

  // Remove markdown code blocks
  if (jsonText.startsWith("```")) {
    const lines = jsonText.split("\n");
    lines.shift(); // Remove first line (```json or ```)
    if (lines.length > 0 && lines[lines.length - 1].trim() === "```") {
      lines.pop(); // Remove last line
    }
    jsonText = lines.join("\n");
  }

  // Extract JSON object by finding first { and last }
  const startIdx = jsonText.indexOf("{");
  const endIdx = jsonText.lastIndexOf("}");
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    jsonText = jsonText.substring(startIdx, endIdx + 1);
  }

  return jsonText.trim();
}

async function trackEvent(
  event: string,
  properties: Record<string, any>,
  distinctId: string = "anonymous"
) {
  if (!POSTHOG_API_KEY || !POSTHOG_HOST) return;

  try {
    // Non-blocking - don't await, fire and forget
    fetch(`${POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_API_KEY,
        event,
        properties,
        distinct_id: distinctId,
      }),
    }).catch(() => {
      // Silently fail - don't break the API
    });
  } catch (e) {
    // Silently fail - don't break the API
  }
}

// ============================================
// LLM Client Creation
// ============================================

function createLLMClient(provider: LLMProvider, model?: string) {
  switch (provider) {
    case "openai":
      if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not found in environment variables");
      }
      return new OpenAI({
        apiKey: OPENAI_API_KEY,
        baseURL: OPENAI_BASE_URL,
      });

    case "azure":
      if (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_ENDPOINT) {
        throw new Error("AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT required");
      }
      return new OpenAI({
        apiKey: AZURE_OPENAI_API_KEY,
        baseURL: `${AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${model || AZURE_OPENAI_MODEL}`,
        defaultQuery: { "api-version": AZURE_OPENAI_API_VERSION },
      });

    case "deepseek":
      if (!DEEPSEEK_API_KEY) {
        throw new Error("DEEPSEEK_API_KEY not found in environment variables");
      }
      return new OpenAI({
        apiKey: DEEPSEEK_API_KEY,
        baseURL: DEEPSEEK_BASE_URL,
      });

    case "siliconflow":
      if (!SILICONFLOW_API_KEY) {
        throw new Error("SILICONFLOW_API_KEY not found in environment variables");
      }
      return new OpenAI({
        apiKey: SILICONFLOW_API_KEY,
        baseURL: SILICONFLOW_BASE_URL,
      });

    case "anthropic":
      if (!ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY not found in environment variables");
      }
      return new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    case "gemini":
      if (!GOOGLE_API_KEY) {
        throw new Error("GOOGLE_API_KEY not found in environment variables");
      }
      return new GoogleGenerativeAI(GOOGLE_API_KEY);

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

// ============================================
// LLM Query Functions
// ============================================

async function queryOpenAI(
  client: OpenAI,
  prompt: string,
  imageDataUrl: string,
  model: string
): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: imageDataUrl },
          },
        ],
      },
    ],
    temperature: 0.7,
  });

  return completion.choices[0].message.content || "";
}

async function queryAnthropic(
  client: Anthropic,
  prompt: string,
  imageBase64: string,
  mimeType: string,
  model: string
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
  });

  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function queryGemini(
  client: GoogleGenerativeAI,
  prompt: string,
  imageBytes: Uint8Array,
  mimeType: string,
  model: string
): Promise<string> {
  const genModel = client.getGenerativeModel({ model });
  const imagePart = {
    inlineData: {
      data: btoa(String.fromCharCode(...imageBytes)),
      mimeType,
    },
  };

  const result = await genModel.generateContent([prompt, imagePart]);
  const response = result.response;
  return response.text();
}

async function queryLLM(
  provider: LLMProvider,
  prompt: string,
  imageBytes: Uint8Array,
  mimeType: string,
  model?: string
): Promise<string> {
  const client = createLLMClient(provider, model);

  // Get default model if not provided
  if (!model) {
    switch (provider) {
      case "openai":
        model = OPENAI_MODEL;
        break;
      case "azure":
        model = AZURE_OPENAI_MODEL;
        break;
      case "anthropic":
        model = ANTHROPIC_MODEL;
        break;
      case "gemini":
        model = GOOGLE_MODEL;
        break;
      case "deepseek":
        model = DEEPSEEK_MODEL;
        break;
      case "siliconflow":
        model = SILICONFLOW_MODEL;
        break;
    }
  }

  // Convert image to appropriate format
  const imageBase64 = btoa(String.fromCharCode(...imageBytes));
  const imageDataUrl = `data:${mimeType};base64,${imageBase64}`;

  // Query based on provider
  if (provider === "openai" || provider === "azure" || provider === "deepseek" || provider === "siliconflow") {
    return queryOpenAI(client as OpenAI, prompt, imageDataUrl, model!);
  } else if (provider === "anthropic") {
    return queryAnthropic(client as Anthropic, prompt, imageBase64, mimeType, model!);
  } else if (provider === "gemini") {
    return queryGemini(client as GoogleGenerativeAI, prompt, imageBytes, mimeType, model!);
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }
}

// ============================================
// Main Handler
// ============================================

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get user if authenticated
    const authHeader = req.headers.get("Authorization");
    const distinctId = authHeader ? "authenticated" : "anonymous";

    // Parse form data
    const formData = await req.formData();
    const imageFile = formData.get("image") as File | null;
    const provider = (formData.get("provider")?.toString() || "azure") as LLMProvider;
    const model = formData.get("model")?.toString();
    const currency = formData.get("currency")?.toString();

    // Validate image
    if (!imageFile) {
      return new Response(
        JSON.stringify({ detail: "Please upload an image file." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validate content type
    if (!imageFile.type || !imageFile.type.startsWith("image/")) {
      return new Response(
        JSON.stringify({ detail: "Please upload an image file." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Track request
    await trackEvent("api_analyze_requested", { provider }, distinctId);

    // Convert image to bytes
    const imageBytes = new Uint8Array(await imageFile.arrayBuffer());
    const mimeType = imageFile.type || "image/jpeg";

    // Build prompt
    const prompt = buildPromptTemplate(currency);

    // Call LLM
    let response: string;
    try {
      response = await queryLLM(provider, prompt, imageBytes, mimeType, model);
    } catch (error: any) {
      const errorMessage = String(error.message || error);

      // Track error
      const errorType =
        errorMessage.toLowerCase().includes("quota") ||
        errorMessage.toLowerCase().includes("insufficient_quota")
          ? "quota"
          : errorMessage.toLowerCase().includes("api_key") ||
              errorMessage.toLowerCase().includes("authentication")
          ? "authentication"
          : "other";

      await trackEvent("api_analyze_error", { provider, error_type: errorType }, distinctId);

      // Return user-friendly error
      let detail: string;
      if (
        errorMessage.toLowerCase().includes("quota") ||
        errorMessage.toLowerCase().includes("insufficient_quota")
      ) {
        detail = `API quota exceeded. Please check your ${provider} account billing and usage limits. Error: ${errorMessage}`;
      } else if (
        errorMessage.toLowerCase().includes("api_key") ||
        errorMessage.toLowerCase().includes("authentication")
      ) {
        detail = `API authentication failed. Please check your ${provider} API key in environment variables. Error: ${errorMessage}`;
      } else {
        detail = `Vision model error: ${errorMessage}`;
      }

      return new Response(
        JSON.stringify({ detail }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!response) {
      return new Response(
        JSON.stringify({ detail: "Vision model failed to return a response." }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse JSON from response
    const jsonText = extractJsonFromResponse(response);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return new Response(
        JSON.stringify({
          detail: `Failed to parse model output as JSON. Raw response: ${response.substring(0, 500)}`,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Normalize and return
    const listing = normalizeListing(parsed);

    // Track success
    await trackEvent(
      "api_analyze_success",
      { provider, has_title: Boolean(listing.title) },
      distinctId
    );

    return new Response(
      JSON.stringify(listing),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ detail: `Internal server error: ${error.message}` }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
