/**
 * Supabase Edge Function: analyze-image
 *
 * Analyzes product images using LLM vision models to generate structured listing data.
 * Supports multiple LLM providers: OpenAI, Azure OpenAI, Anthropic, Gemini, DeepSeek, SiliconFlow.
 *
 * Endpoint: POST /functions/v1/analyze-image
 * Content-Type: multipart/form-data
 * Authentication: OPTIONAL - Unauthenticated users can analyze images (with lower rate limits)
 *
 * Request fields:
 * - image (file, required): Image file (JPEG, PNG, etc.)
 * - provider (string, optional): LLM provider name (default: "azure")
 * - model (string, optional): Specific model to use (default: provider-specific)
 * - currency (string, optional): Currency code for price estimation (e.g., "USD", "EUR")
 *
 * Response:
 * - For unauthenticated users: Returns ListingData only
 * - For authenticated users: Returns { ...ListingData, quota: {...} }
 *   - Current quota is returned (but NOT decremented)
 *   - Quota is only decremented when listing is created via /listings-create
 *
 * Rate Limits:
 * - Unauthenticated: 10 requests/hour, 5 requests/15 minutes
 * - Authenticated: 50 requests/hour
 *
 * Quota:
 * - Creation quota is decremented AFTER successful analysis (each generation consumes quota)
 * - Quota is checked before analysis - returns 402 if quota exceeded
 * - Returns 502 status if LLM fails or returns empty/invalid data (quota not decremented)
 * - Note: /listings-create only decrements save slots, not creation quota
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import OpenAI from "https://esm.sh/openai@4.0.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.18.0";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.3.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
    checkRateLimit,
    checkRateLimitReadonly,
    getRateLimitHeaders,
    getRateLimitIdentifier,
    createRateLimitErrorResponse,
} from "../_shared/rate-limit.ts";

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
// GPT-5 models require API version 2025-08-07 or newer for Chat Completions
// You can also set AZURE_OPENAI_API_VERSION environment variable to override this
const AZURE_OPENAI_API_VERSION = Deno.env.get("AZURE_OPENAI_API_VERSION") || "2025-08-07";
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

/**
 * Convert Uint8Array to base64 string efficiently without stack overflow
 * Uses chunked approach to handle large images safely
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
    try {
        // Use chunked approach to avoid stack overflow for large arrays
        // Process in smaller chunks to safely use apply() without exceeding call stack
        // Conservative chunk size to ensure apply() doesn't exceed stack limits
        const chunkSize = 16384; // 16KB chunks - safe for apply() on all platforms
        const chunks: string[] = [];

        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.slice(i, i + chunkSize);
            // Convert chunk to array first, then use apply (safer than spread operator)
            const chunkArray = Array.from(chunk);
            chunks.push(String.fromCharCode.apply(null, chunkArray));
        }

        return btoa(chunks.join(''));
    } catch (error: any) {
        console.error(`Base64 conversion failed - size: ${bytes.length} bytes, error: ${error.message}`);
        throw new Error(`Failed to convert image to base64: ${error.message}`);
    }
}

function buildPromptTemplate(currency?: string): string {
    const currencyContext = currency
        ? `\n- Estimate price in ${currency} based on the item's condition, brand, age, and market value. Use realistic pricing appropriate for ${currency} (e.g., a used chair might be 45-150 ${currency}, a new phone might be 500-1200 ${currency}). If you cannot reasonably estimate the price, return an empty string. Do NOT use placeholder values like 120.`
        : `\n- Estimate price based on the item's condition, brand, age, and market value. Use realistic pricing (e.g., a used chair might be 45-150, a new phone might be 500-1200). If you cannot reasonably estimate the price, return an empty string. Do NOT use placeholder values like 120.`;

    return `You are SnapSell, an assistant that helps people list second-hand items.

Analyze the attached product photo and return ONLY valid JSON (no markdown, no code blocks, no explanations) matching this exact schema:

{
  "title": string,          // REQUIRED: short, searchable product headline (e.g., "Vintage Wooden Chair" or "iPhone 12 Pro Max")
  "price": string,          // numeric price, no currency symbol (empty string if cannot estimate)
  "description": string,    // 2-3 concise sentences with key selling points
  "condition": string,      // one of: "New", "Used - Like New", "Used - Good", "Used - Fair", "Refurbished"
  "location": string        // city or neighborhood if inferable, otherwise empty string
}

CRITICAL REQUIREMENTS:
- The "title" field is MANDATORY and must never be empty. You must always provide a descriptive title based on what you see in the image.
- Return ONLY the JSON object, nothing else. No markdown code blocks, no explanations, no text before or after.
- Use double quotes for all JSON strings (not single quotes).
- All string values must be properly escaped if they contain quotes.${currencyContext}
- Keep description under 400 characters.
- Prefer realistic consumer-friendly language.
- If you cannot infer optional fields (price, location), return an empty string for those fields only.
- You must always provide at least: title, description, and condition.`;
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

    // Try to parse as-is first
    try {
        JSON.parse(jsonText);
        return jsonText.trim(); // Already valid JSON
    } catch (e) {
        // JSON is invalid, try to fix common issues
        // The most common issue is single quotes instead of double quotes
        // We'll do a simple replacement for common patterns

        let fixed = jsonText;

        // Fix keys: 'key': -> "key":
        fixed = fixed.replace(/'([a-zA-Z_][a-zA-Z0-9_]*)':/g, '"$1":');

        // Fix values: : 'value' -> : "value" (but handle empty strings specially)
        // Pattern: : '' -> : ""
        fixed = fixed.replace(/:\s*''/g, ': ""');
        // Pattern: : '...' -> : "..." (for non-empty strings)
        // Use a more careful regex that handles escaped quotes
        fixed = fixed.replace(/:\s*'((?:[^'\\]|\\.)*)'/g, ': "$1"');

        // Try parsing the fixed version
        try {
            JSON.parse(fixed);
            return fixed.trim();
        } catch (e2) {
            // If still invalid, try one more approach: replace all single quotes with double quotes
            // This is a last resort and might break strings with apostrophes, but it's better than failing
            let lastResort = jsonText;
            // Only replace single quotes that are clearly delimiters (not in the middle of words)
            // Pattern: whitespace or : followed by ' and ending with ' followed by , or } or whitespace
            lastResort = lastResort.replace(/([{,:\s])'([^']*)'([,}\s])/g, '$1"$2"$3');

            try {
                JSON.parse(lastResort);
                return lastResort.trim();
            } catch (e3) {
                // Give up and return original - let the error handler deal with it
                return jsonText.trim();
            }
        }
    }
}

function trackEvent(
    event: string,
    properties: Record<string, any>,
    distinctId: string = "anonymous"
): void {
    if (!POSTHOG_API_KEY || !POSTHOG_HOST) return;

    // Non-blocking - fire and forget, don't return a promise
    try {
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
            // For Azure OpenAI, the TypeScript SDK works the same as Python SDK:
            // - Use baseURL with /openai/v1/ (e.g., https://resource.openai.azure.com/openai/v1/)
            // - Pass deployment name as the model parameter in API calls
            //
            // Accept endpoints in formats:
            // 1. https://resource.openai.azure.com/openai/v1/ (preferred)
            // 2. https://resource.openai.azure.com (will normalize to add /openai/v1)
            // 3. https://resource.openai.azure.com/openai/deployments/{deployment} (will normalize)
            let azureEndpoint = AZURE_OPENAI_ENDPOINT.replace(/\/$/, "");

            // Remove /openai/deployments/... if already present (wrong format)
            if (azureEndpoint.includes("/openai/deployments/")) {
                azureEndpoint = azureEndpoint.split("/openai/deployments/")[0];
            }

            // Ensure endpoint ends with /openai/v1 (add if missing)
            if (!azureEndpoint.includes("/openai/v1")) {
                // If it's just the base resource URL, add /openai/v1
                azureEndpoint = `${azureEndpoint}/openai/v1`;
            } else if (azureEndpoint.endsWith("/openai/v1")) {
                // Already correct, no trailing slash needed
            } else {
                // Has /openai/v1 but might have extra path, normalize
                const v1Index = azureEndpoint.indexOf("/openai/v1");
                azureEndpoint = azureEndpoint.substring(0, v1Index + "/openai/v1".length);
            }

            // Get deployment name - use provided model or fall back to environment variable
            // Read environment variable at runtime to ensure we get the latest value
            const envDeploymentName = Deno.env.get("AZURE_OPENAI_MODEL_DEPLOYMENT") || AZURE_OPENAI_MODEL;
            const deploymentName = model || envDeploymentName;

            console.log(`[createLLMClient] Azure OpenAI configuration:`, {
                originalEndpoint: AZURE_OPENAI_ENDPOINT,
                normalizedBaseURL: azureEndpoint,
                providedModel: model || "(none)",
                envDeploymentName,
                finalDeploymentName: deploymentName,
                apiVersion: AZURE_OPENAI_API_VERSION,
                note: "Deployment name will be passed as 'model' parameter in API calls",
            });

            return new OpenAI({
                apiKey: AZURE_OPENAI_API_KEY,
                baseURL: azureEndpoint,
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
    // For Azure OpenAI with /openai/v1/ baseURL format:
    // - The deployment name is passed directly as the model parameter
    // - No need to extract from baseURL (that was for the old /openai/deployments/{deployment} format)
    const clientBaseURL = (client as any).baseURL || "";
    const isAzureV1Format = clientBaseURL.includes("/openai/v1");

    if (isAzureV1Format) {
        console.log(`[queryOpenAI] Azure OpenAI detected (v1 format), using deployment name as model: ${model}, baseURL: ${clientBaseURL}`);
    } else if (clientBaseURL.includes("/openai/deployments/")) {
        // Legacy format - extract deployment from baseURL for backward compatibility
        const deploymentMatch = clientBaseURL.match(/\/openai\/deployments\/([^\/]+)/);
        if (deploymentMatch && deploymentMatch[1]) {
            const extractedDeployment = deploymentMatch[1];
            console.log(`[queryOpenAI] Azure OpenAI detected (legacy deployments format), extracted deployment: ${extractedDeployment}, using model param: ${model}`);
            // Use the extracted deployment to ensure consistency
            model = extractedDeployment;
        }
    }

    console.log(`[queryOpenAI] Making request with model: ${model}, baseURL: ${clientBaseURL}`);

    const completion = await client.chat.completions.create({
        model: model,
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
            data: uint8ArrayToBase64(imageBytes),
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
    // Read environment variables at runtime to ensure we get the latest values
    if (!model) {
        switch (provider) {
            case "openai":
                model = Deno.env.get("OPENAI_MODEL_DEPLOYMENT") || OPENAI_MODEL;
                break;
            case "azure":
                model = Deno.env.get("AZURE_OPENAI_MODEL_DEPLOYMENT") || AZURE_OPENAI_MODEL;
                console.log(`[queryLLM] Azure model selection - env var: ${Deno.env.get("AZURE_OPENAI_MODEL_DEPLOYMENT") || "(not set)"}, fallback: ${AZURE_OPENAI_MODEL}, final: ${model}`);
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
    } else {
        console.log(`[queryLLM] Using provided model: ${model}`);
    }

    // Convert image to appropriate format with error handling
    let imageBase64: string;
    let imageDataUrl: string;
    try {
        console.log(`[queryLLM] Converting image to base64, size: ${imageBytes.length} bytes`);
        imageBase64 = uint8ArrayToBase64(imageBytes);
        imageDataUrl = `data:${mimeType};base64,${imageBase64}`;
        console.log(`[queryLLM] Base64 conversion successful, length: ${imageBase64.length} chars`);
    } catch (error: any) {
        console.error(`[queryLLM] Base64 conversion failed:`, error);
        throw new Error(`Failed to convert image to base64: ${error.message || error}`);
    }

    // Query based on provider
    try {
        if (provider === "openai" || provider === "azure" || provider === "deepseek" || provider === "siliconflow") {
            return await queryOpenAI(client as OpenAI, prompt, imageDataUrl, model!);
        } else if (provider === "anthropic") {
            return await queryAnthropic(client as Anthropic, prompt, imageBase64, mimeType, model!);
        } else if (provider === "gemini") {
            return await queryGemini(client as GoogleGenerativeAI, prompt, imageBytes, mimeType, model!);
        } else {
            throw new Error(`Unsupported provider: ${provider}`);
        }
    } catch (error: any) {
        console.error(`[queryLLM] LLM query failed for provider ${provider}:`, {
            error: error.message || error,
            errorType: error.constructor?.name,
            stack: error.stack,
        });
        throw error;
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
        // IMPORTANT: Authentication is OPTIONAL - this endpoint allows unauthenticated access
        // Unauthenticated users can analyze images (with lower rate limits)
        // The frontend only includes Authorization header if user is logged in
        // We NEVER return 401 for missing auth - unauthenticated requests are always allowed
        const authHeader = req.headers.get("Authorization");
        const isAuthenticated = !!authHeader;
        const distinctId = isAuthenticated ? "authenticated" : "anonymous";

        // Log for debugging (can be removed in production)
        console.log(`Analyze image request - Authenticated: ${isAuthenticated}`);

        // Initialize Supabase admin client for rate limiting
        const supabaseUrl = Deno.env.get("SUPABASE_URL");
        const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        let userId: string | undefined;

        // Get user ID if authenticated (optional - never blocks unauthenticated requests)
        if (authHeader && supabaseUrl && supabaseServiceRoleKey) {
            try {
                const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
                if (supabaseAnonKey) {
                    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
                        global: {
                            headers: { Authorization: authHeader },
                        },
                    });
                    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
                    if (!authError && user) {
                        userId = user.id;
                        console.log(`User authenticated: ${userId}`);
                    } else {
                        console.log(`Auth check failed - error: ${authError?.message}, user: ${user?.id || "null"}`);
                    }
                    // If auth fails or user is null, continue as unauthenticated (no error thrown)
                } else {
                    console.log("SUPABASE_ANON_KEY not found, cannot verify user");
                }
            } catch (e) {
                // If auth check fails for any reason, continue as unauthenticated
                // This ensures unauthenticated users can always use the endpoint
                console.log("Auth check failed, proceeding as unauthenticated:", e);
            }
        } else {
            console.log(`Auth check skipped - authHeader: ${!!authHeader}, supabaseUrl: ${!!supabaseUrl}, serviceRoleKey: ${!!supabaseServiceRoleKey}`);
        }

        // Check rate limits
        console.log(`[Analyze-Image] Starting rate limit checks, userId: ${userId || "none"}`);
        if (supabaseUrl && supabaseServiceRoleKey) {
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
            const identifier = getRateLimitIdentifier(req, userId);
            console.log(`[Analyze-Image] Rate limit identifier: ${identifier}`);

            // For unauthenticated users: Check daily quota FIRST (business limit)
            // Then check hourly/15-min rate limits (abuse prevention)
            if (!userId) {
                // Check daily quota FIRST - this is the actual feature limit (10 per day)
                // Use readonly check to avoid incrementing on failed requests
                console.log(`[Analyze-Image] Checking daily quota for unauthenticated user (10 per day)`);
                const dailyQuotaResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image-daily",
                    10,
                    1440 // 24 hours in minutes
                );
                console.log(`[Analyze-Image] Daily quota result:`, {
                    allowed: dailyQuotaResult.allowed,
                    remaining: dailyQuotaResult.remaining,
                    resetAt: dailyQuotaResult.resetAt.toISOString(),
                });

                if (!dailyQuotaResult.allowed) {
                    console.log(`[Analyze-Image] Daily quota exceeded, returning 402 response`);
                    trackEvent("api_analyze_quota_exceeded", { provider: "unknown", quota_type: "daily" }, distinctId);
                    try {
                        const rateLimitHeaders = getRateLimitHeaders(dailyQuotaResult);
                        return new Response(
                            JSON.stringify({
                                error: "Daily creation limit exceeded",
                                code: "ANONYMOUS_DAILY_LIMIT_EXCEEDED",
                                message: "You've reached your daily creation limit (10 per day). Sign in for higher limits or try again tomorrow.",
                                creations_remaining_today: dailyQuotaResult.remaining,
                                creations_daily_limit: 10,
                                resets_at: dailyQuotaResult.resetAt.toISOString(),
                            }),
                            {
                                status: 402,
                                headers: {
                                    ...corsHeaders,
                                    ...rateLimitHeaders,
                                    "Content-Type": "application/json",
                                },
                            }
                        );
                    } catch (error: any) {
                        console.error(`[Analyze-Image] Error creating daily quota exceeded response:`, error);
                        return new Response(
                            JSON.stringify({
                                error: "Daily creation limit exceeded",
                                code: "ANONYMOUS_DAILY_LIMIT_EXCEEDED",
                                message: "You've reached your daily creation limit (10 per day). Sign in for higher limits or try again tomorrow.",
                                creations_remaining_today: dailyQuotaResult.remaining,
                                creations_daily_limit: 10,
                                resets_at: dailyQuotaResult.resetAt.toISOString(),
                            }),
                            {
                                status: 402,
                                headers: { ...corsHeaders, "Content-Type": "application/json" },
                            }
                        );
                    }
                }

                // Then check 15-minute window (5 requests) - abuse prevention
                // IMPORTANT: Use readonly check here - we only increment AFTER successful analysis
                // This prevents failed requests (502 errors, LLM failures) from counting against the limit
                console.log(`[Analyze-Image] Checking 15-minute rate limit for unauthenticated user`);
                const shortWindowResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image-short",
                    5,
                    15
                );
                console.log(`[Analyze-Image] 15-minute rate limit result:`, {
                    allowed: shortWindowResult.allowed,
                    remaining: shortWindowResult.remaining,
                });

                if (!shortWindowResult.allowed) {
                    console.log(`[Analyze-Image] 15-minute rate limit exceeded, returning 429 response`);
                    trackEvent("api_analyze_rate_limited", { provider: "unknown" }, distinctId);
                    try {
                        return createRateLimitErrorResponse(shortWindowResult, corsHeaders);
                    } catch (error: any) {
                        console.error(`[Analyze-Image] Error creating rate limit response:`, error);
                        return new Response(
                            JSON.stringify({
                                error: "Rate limit exceeded. Please try again later.",
                                code: "RATE_LIMIT_EXCEEDED",
                                remaining: shortWindowResult.remaining,
                                limit: shortWindowResult.limit,
                            }),
                            {
                                status: 429,
                                headers: { ...corsHeaders, "Content-Type": "application/json" },
                            }
                        );
                    }
                }
            }

            // Check hourly limit (for both authenticated and unauthenticated)
            // Rate limits:
            // - Unauthenticated: 10 per hour (60 minutes)
            // - Authenticated: 50 per hour
            // IMPORTANT: Use readonly check here - we only increment AFTER successful analysis
            // This prevents failed requests (502 errors, LLM failures) from counting against the limit
            const hourlyLimit = userId ? 50 : 10;
            const hourlyWindow = 60;

            console.log(`[Analyze-Image] Checking hourly rate limit (limit: ${hourlyLimit}, window: ${hourlyWindow}min)`);
            const hourlyResult = await checkRateLimitReadonly(
                supabaseAdmin,
                identifier,
                "analyze-image",
                hourlyLimit,
                hourlyWindow
            );
            console.log(`[Analyze-Image] Hourly rate limit result:`, {
                allowed: hourlyResult.allowed,
                remaining: hourlyResult.remaining,
                resetAt: hourlyResult.resetAt.toISOString(),
            });

            if (!hourlyResult.allowed) {
                console.log(`[Analyze-Image] Hourly rate limit exceeded, returning 429 response`);
                trackEvent("api_analyze_rate_limited", { provider: "unknown" }, distinctId);
                try {
                    return createRateLimitErrorResponse(hourlyResult, corsHeaders);
                } catch (error: any) {
                    console.error(`[Analyze-Image] Error creating hourly rate limit response:`, error);
                    return new Response(
                        JSON.stringify({
                            error: "Rate limit exceeded. Please try again later or sign in for higher limits.",
                            code: "RATE_LIMIT_EXCEEDED",
                            remaining: hourlyResult.remaining,
                            limit: hourlyResult.limit,
                        }),
                        {
                            status: 429,
                            headers: { ...corsHeaders, "Content-Type": "application/json" },
                        }
                    );
                }
            }
        }

        // Parse form data
        console.log(`[Analyze-Image] Starting form data parsing`);
        let formData: FormData;
        try {
            formData = await req.formData();
            console.log(`[Analyze-Image] Form data parsed successfully`);
        } catch (error: any) {
            console.error(`[Analyze-Image] Form data parsing failed:`, {
                error: error.message || error,
                errorType: error.constructor?.name,
            });
            throw new Error(`Failed to parse form data: ${error.message || error}`);
        }

        const imageFile = formData.get("image") as File | null;
        const provider = (formData.get("provider")?.toString() || "azure") as LLMProvider;
        const model = formData.get("model")?.toString();
        const currency = formData.get("currency")?.toString();
        console.log(`[Analyze-Image] Form data extracted:`, {
            hasImage: !!imageFile,
            imageFileName: imageFile?.name,
            imageFileSize: imageFile?.size,
            imageFileType: imageFile?.type,
            provider,
            model: model || "default",
            currency: currency || "none",
        });

        // Validate image
        if (!imageFile) {
            // Get rate limit headers (readonly - don't increment for validation errors)
            let rateLimitHeaders: Record<string, string> = {} as Record<string, string>;
            if (supabaseUrl && supabaseServiceRoleKey) {
                const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
                const identifier = getRateLimitIdentifier(req, userId);
                const hourlyLimit = userId ? 50 : 10;
                const hourlyResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image",
                    hourlyLimit,
                    60
                );
                rateLimitHeaders = getRateLimitHeaders(hourlyResult);
            }

            return new Response(
                JSON.stringify({ detail: "Please upload an image file." }),
                {
                    status: 400,
                    headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
                }
            );
        }

        // Validate content type
        if (!imageFile.type || !imageFile.type.startsWith("image/")) {
            // Get rate limit headers (readonly - don't increment for validation errors)
            let rateLimitHeaders: Record<string, string> = {} as Record<string, string>;
            if (supabaseUrl && supabaseServiceRoleKey) {
                const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
                const identifier = getRateLimitIdentifier(req, userId);
                const hourlyLimit = userId ? 50 : 10;
                const hourlyResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image",
                    hourlyLimit,
                    60
                );
                rateLimitHeaders = getRateLimitHeaders(hourlyResult);
            }

            return new Response(
                JSON.stringify({ detail: "Please upload an image file." }),
                {
                    status: 400,
                    headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
                }
            );
        }

        // Track request (after rate limit check passes) - non-blocking
        trackEvent("api_analyze_requested", { provider }, distinctId);

        // Get rate limit headers for response (readonly - we'll increment after success)
        let rateLimitHeaders: Record<string, string> = {};
        if (supabaseUrl && supabaseServiceRoleKey) {
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
            const identifier = getRateLimitIdentifier(req, userId);
            const hourlyLimit = userId ? 50 : 10;
            const hourlyResult = await checkRateLimitReadonly(
                supabaseAdmin,
                identifier,
                "analyze-image",
                hourlyLimit,
                60
            );
            rateLimitHeaders = getRateLimitHeaders(hourlyResult);
        }

        // If authenticated, check quota availability before analyzing
        // Quota is decremented AFTER successful analysis (each generation consumes quota)
        if (userId && supabaseUrl && supabaseServiceRoleKey) {
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
            const { data: quotaData, error: quotaError } = await supabaseAdmin.rpc("get_user_quota", {
                p_user_id: userId,
            });

            if (quotaError) {
                console.error("[Analyze-Image] Quota check error:", quotaError);
                return new Response(
                    JSON.stringify({
                        error: "Failed to check creation quota",
                        details: quotaError.message
                    }),
                    {
                        status: 500,
                        headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" }
                    }
                );
            }

            const quota = quotaData?.[0];
            const totalCreationsRemaining = (quota?.creations_remaining_today ?? 0) + (quota?.bonus_creations_remaining ?? 0);

            if (totalCreationsRemaining < 1) {
                // Track analytics (non-blocking)
                supabaseAdmin.from("usage_logs").insert({
                    user_id: userId,
                    action: "analyze_image",
                    meta: { blocked: true, reason: "creation_quota_exceeded" },
                }).then(({ error }) => {
                    if (error) console.error("Analytics error:", error);
                });

                trackEvent("api_analyze_error", { provider, error_type: "quota_exceeded" }, distinctId);

                return new Response(
                    JSON.stringify({
                        error: "Creation quota exceeded",
                        code: "CREATION_QUOTA_EXCEEDED",
                        creations_remaining_today: quota?.creations_remaining_today || 0,
                        bonus_creations_remaining: quota?.bonus_creations_remaining || 0,
                        message: "You've reached your daily creation limit. Purchase a pack to continue.",
                        purchase_url: "/purchases",
                    }),
                    {
                        status: 402,
                        headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" }
                    }
                );
            }
        }

        // Convert image to bytes
        let imageBytes: Uint8Array;
        let mimeType: string;
        try {
            imageBytes = new Uint8Array(await imageFile.arrayBuffer());
            mimeType = imageFile.type || "image/jpeg";
        } catch (error: any) {
            console.error(`Failed to read image file: ${error.message}`);
            trackEvent("api_analyze_error", { provider, error_type: "image_read_failed" }, distinctId);

            let rateLimitHeaders: Record<string, string> = {};
            if (supabaseUrl && supabaseServiceRoleKey) {
                const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
                const identifier = getRateLimitIdentifier(req, userId);
                const hourlyLimit = userId ? 50 : 10;
                const hourlyResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image",
                    hourlyLimit,
                    60
                );
                rateLimitHeaders = getRateLimitHeaders(hourlyResult);
            }

            return new Response(
                JSON.stringify({
                    detail: `Failed to read image file: ${error.message}`,
                    code: "IMAGE_READ_ERROR"
                }),
                {
                    status: 400,
                    headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
                }
            );
        }

        const imageSizeMB = imageBytes.length / (1024 * 1024);
        console.log(`Image processing - size: ${imageSizeMB.toFixed(2)}MB, type: ${mimeType}, provider: ${provider}`);

        // Validate image size (max 10MB to prevent memory issues)
        const MAX_IMAGE_SIZE_MB = 10;
        if (imageSizeMB > MAX_IMAGE_SIZE_MB) {
            trackEvent("api_analyze_error", { provider, error_type: "image_too_large", size_mb: imageSizeMB }, distinctId);

            let rateLimitHeaders: Record<string, string> = {};
            if (supabaseUrl && supabaseServiceRoleKey) {
                const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
                const identifier = getRateLimitIdentifier(req, userId);
                const hourlyLimit = userId ? 50 : 10;
                const hourlyResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image",
                    hourlyLimit,
                    60
                );
                rateLimitHeaders = getRateLimitHeaders(hourlyResult);
            }

            return new Response(
                JSON.stringify({
                    detail: `Image is too large (${imageSizeMB.toFixed(2)}MB). Maximum size is ${MAX_IMAGE_SIZE_MB}MB. Please compress or resize your image.`,
                    code: "IMAGE_TOO_LARGE"
                }),
                {
                    status: 400,
                    headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
                }
            );
        }

        // Build prompt
        const prompt = buildPromptTemplate(currency);

        // Call LLM with timeout (60 seconds)
        let response: string;
        try {
            console.log(`Calling LLM with provider: ${provider}, model: ${model || "default"}, image size: ${imageSizeMB.toFixed(2)}MB`);
            const startTime = Date.now();

            // Add timeout wrapper for LLM calls
            const LLM_TIMEOUT_MS = 60000; // 60 seconds
            const llmPromise = queryLLM(provider, prompt, imageBytes, mimeType, model);
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error(`LLM request timed out after ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS);
            });

            response = await Promise.race([llmPromise, timeoutPromise]);
            const elapsedTime = Date.now() - startTime;
            console.log(`LLM response received in ${elapsedTime}ms, length: ${response?.length || 0}, preview: ${response?.substring(0, 200) || "empty"}`);
        } catch (error: any) {
            const errorMessage = String(error.message || error);
            const errorStack = error.stack || "no stack";
            const errorName = error.name || error.constructor?.name || "UnknownError";

            console.error(`[Analyze-Image] LLM call failed:`, {
                provider,
                model: model || "default",
                errorMessage,
                errorName,
                errorStack: errorStack.substring(0, 500), // Limit stack trace length
                imageSizeMB: imageSizeMB.toFixed(2),
                imageSizeBytes: imageBytes.length,
            });

            // Track error
            const errorType =
                errorMessage.toLowerCase().includes("quota") ||
                    errorMessage.toLowerCase().includes("insufficient_quota")
                    ? "quota"
                    : errorMessage.toLowerCase().includes("api_key") ||
                        errorMessage.toLowerCase().includes("authentication")
                        ? "authentication"
                        : errorMessage.toLowerCase().includes("resource not found") ||
                            errorMessage.toLowerCase().includes("not found")
                            ? "resource_not_found"
                            : "other";

            trackEvent("api_analyze_error", { provider, error_type: errorType }, distinctId);

            // Return user-friendly error with more context
            let detail: string;
            let errorCode = "LLM_ERROR";

            if (errorMessage.toLowerCase().includes("timeout")) {
                detail = `The image analysis request timed out. The image may be too large or the service is temporarily unavailable. Please try again with a smaller image.`;
                errorCode = "LLM_TIMEOUT";
            } else if (
                errorMessage.toLowerCase().includes("quota") ||
                errorMessage.toLowerCase().includes("insufficient_quota")
            ) {
                detail = `API quota exceeded. Please check your ${provider} account billing and usage limits. Error: ${errorMessage}`;
                errorCode = "LLM_QUOTA_EXCEEDED";
            } else if (
                errorMessage.toLowerCase().includes("api_key") ||
                errorMessage.toLowerCase().includes("authentication")
            ) {
                detail = `API authentication failed. Please check your ${provider} API key in environment variables. Error: ${errorMessage}`;
                errorCode = "LLM_AUTH_ERROR";
            } else if (
                errorMessage.toLowerCase().includes("rate limit") ||
                errorMessage.toLowerCase().includes("rate_limit")
            ) {
                detail = `Rate limit exceeded for ${provider} API. Please try again later.`;
                errorCode = "LLM_RATE_LIMIT";
            } else if (
                provider === "azure" &&
                (errorMessage.toLowerCase().includes("resource not found") ||
                    errorMessage.toLowerCase().includes("not found"))
            ) {
                detail = `Azure OpenAI deployment not found. Please verify that:
1. The deployment name "${model || AZURE_OPENAI_MODEL}" exists in your Azure OpenAI resource
2. The endpoint URL "${AZURE_OPENAI_ENDPOINT}" is correct
3. The API version "${AZURE_OPENAI_API_VERSION}" is supported
4. The deployment supports vision models (e.g., gpt-4o, gpt-4-turbo)
Error: ${errorMessage}`;
                errorCode = "AZURE_DEPLOYMENT_NOT_FOUND";
            } else {
                detail = `Vision model error: ${errorMessage}. Please try again with a different image or provider.`;
            }

            // Get rate limit headers for error response (readonly - don't increment for failed LLM calls)
            let rateLimitHeaders: Record<string, string> = {};
            if (supabaseUrl && supabaseServiceRoleKey) {
                const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
                const identifier = getRateLimitIdentifier(req, userId);
                const hourlyLimit = userId ? 50 : 10;
                const hourlyResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image",
                    hourlyLimit,
                    60
                );
                rateLimitHeaders = getRateLimitHeaders(hourlyResult);
            }

            return new Response(
                JSON.stringify({
                    detail,
                    code: errorCode,
                    provider,
                    image_size_mb: imageSizeMB.toFixed(2)
                }),
                {
                    status: 502,
                    headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
                }
            );
        }

        if (!response || response.trim().length === 0) {
            console.error(`[Analyze-Image] LLM returned empty response:`, {
                provider,
                model: model || "default",
                responseLength: response?.length || 0,
                responseType: typeof response,
                responseIsNull: response === null,
                responseIsUndefined: response === undefined,
            });

            trackEvent("api_analyze_error", { provider, error_type: "empty_response", model: model || "default" }, distinctId);

            // Get rate limit headers (readonly - don't increment for failed LLM calls)
            let rateLimitHeaders: Record<string, string> = {} as Record<string, string>;
            if (supabaseUrl && supabaseServiceRoleKey) {
                const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
                const identifier = getRateLimitIdentifier(req, userId);
                const hourlyLimit = userId ? 50 : 10;
                const hourlyResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image",
                    hourlyLimit,
                    60
                );
                rateLimitHeaders = getRateLimitHeaders(hourlyResult);
            }

            return new Response(
                JSON.stringify({
                    detail: "Vision model failed to return a response. Please try again with a different image or provider.",
                    code: "LLM_EMPTY_RESPONSE",
                    provider,
                }),
                {
                    status: 502,
                    headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
                }
            );
        }

        // Parse JSON from response
        const jsonText = extractJsonFromResponse(response);
        console.log(`Extracted JSON text, length: ${jsonText?.length || 0}, preview: ${jsonText?.substring(0, 200) || "empty"}`);
        let parsed: any;
        try {
            parsed = JSON.parse(jsonText);
            console.log(`Parsed JSON successfully:`, {
                hasTitle: !!parsed.title,
                hasPrice: !!parsed.price,
                hasDescription: !!parsed.description,
                hasCondition: !!parsed.condition,
                hasLocation: !!parsed.location,
                titleValue: parsed.title || "(empty)",
                priceValue: parsed.price || "(empty)",
                keys: Object.keys(parsed)
            });
        } catch (e: any) {
            console.error(`JSON parse error:`, {
                error: e.message || e,
                errorType: e.constructor?.name,
                rawResponse: response ? response.substring(0, 500) : "response is undefined",
                extractedJson: jsonText ? jsonText.substring(0, 500) : "jsonText is undefined",
                jsonTextLength: jsonText?.length || 0
            });

            // Get rate limit headers (readonly - don't increment for parsing errors)
            let rateLimitHeaders: Record<string, string> = {} as Record<string, string>;
            if (supabaseUrl && supabaseServiceRoleKey) {
                const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
                const identifier = getRateLimitIdentifier(req, userId);
                const hourlyLimit = userId ? 50 : 10;
                const hourlyResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image",
                    hourlyLimit,
                    60
                );
                rateLimitHeaders = getRateLimitHeaders(hourlyResult);
            }

            return new Response(
                JSON.stringify({
                    detail: `Failed to parse model output as JSON. The vision model may have returned invalid JSON. Please try again with a clearer image.`,
                    code: "JSON_PARSE_ERROR",
                    raw_preview: response ? response.substring(0, 200) : "response is undefined"
                }),
                {
                    status: 502,
                    headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
                }
            );
        }

        // Normalize and return
        const listing = normalizeListing(parsed);

        // Validate that we got meaningful data from the LLM
        // Require at least title and description to be non-empty
        const hasTitle = listing.title && listing.title.trim().length > 0;
        const hasDescription = listing.description && listing.description.trim().length > 0;
        const hasCondition = listing.condition && listing.condition.trim().length > 0;

        if (!hasTitle || !hasDescription || !hasCondition) {
            console.error("[Analyze-Image] LLM returned empty or invalid data:", {
                provider,
                model: model || "default",
                rawResponse: response ? response.substring(0, 500) : "response is undefined",
                rawResponseLength: response?.length || 0,
                extractedJson: jsonText ? jsonText.substring(0, 500) : "jsonText is undefined",
                parsed,
                listing,
                validation: {
                    hasTitle,
                    hasDescription,
                    hasCondition,
                    titleValue: listing.title || "(empty)",
                    descriptionValue: listing.description ? listing.description.substring(0, 100) + "..." : "(empty)",
                    conditionValue: listing.condition || "(empty)",
                }
            });

            trackEvent("api_analyze_error", {
                provider,
                error_type: "invalid_data",
                model: model || "default",
                missing_fields: {
                    title: !hasTitle,
                    description: !hasDescription,
                    condition: !hasCondition
                }
            }, distinctId);

            // Get rate limit headers for error response (readonly - don't increment for invalid data)
            let rateLimitHeaders: Record<string, string> = {};
            if (supabaseUrl && supabaseServiceRoleKey) {
                const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
                const identifier = getRateLimitIdentifier(req, userId);
                const hourlyLimit = userId ? 50 : 10;
                const hourlyResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image",
                    hourlyLimit,
                    60
                );
                rateLimitHeaders = getRateLimitHeaders(hourlyResult);
            }

            // Provide more specific error message
            const missingFields: string[] = [];
            if (!hasTitle) missingFields.push("title");
            if (!hasDescription) missingFields.push("description");
            if (!hasCondition) missingFields.push("condition");

            return new Response(
                JSON.stringify({
                    error: "Image analysis failed",
                    detail: `The vision model did not return valid listing data. Missing required fields: ${missingFields.join(", ")}. This may happen if the image is unclear, contains no recognizable product, or the model cannot analyze it. Please try again with a clearer image of a product.`,
                    code: "ANALYSIS_FAILED",
                    missing_fields: missingFields,
                    provider
                }),
                {
                    status: 502,
                    headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
                }
            );
        }

        // Track quota usage AFTER successful analysis
        // For authenticated users: decrement creation quota
        // For unauthenticated users: track daily quota usage
        if (supabaseUrl && supabaseServiceRoleKey) {
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
            const identifier = getRateLimitIdentifier(req, userId);

            if (userId) {
                // Authenticated users: decrement creation quota
                console.log(`[Analyze-Image] Decrementing creation quota for user ${userId} after successful analysis`);

                // Get quota before decrement for logging
                const { data: quotaBeforeData } = await supabaseAdmin.rpc("get_user_quota", {
                    p_user_id: userId,
                });
                const quotaBefore = quotaBeforeData?.[0];
                console.log(`[Analyze-Image] Quota before decrement:`, {
                    creations_remaining_today: quotaBefore?.creations_remaining_today,
                    bonus_creations_remaining: quotaBefore?.bonus_creations_remaining,
                });

                const { data: quotaDecremented, error: quotaDecrementError } = await supabaseAdmin.rpc(
                    "decrement_creation_quota",
                    {
                        p_user_id: userId,
                        p_amount: 1,
                    }
                );

                console.log(`[Analyze-Image] Decrement result:`, {
                    userId,
                    quotaDecremented,
                    error: quotaDecrementError,
                    errorMessage: quotaDecrementError?.message,
                    errorCode: quotaDecrementError?.code,
                });

                if (quotaDecrementError) {
                    console.error("[Analyze-Image] Decrement error after successful analysis:", JSON.stringify(quotaDecrementError, null, 2));
                    // Don't fail the request - analysis succeeded, but log the error
                } else if (!quotaDecremented) {
                    console.error("[Analyze-Image] Decrement returned false after successful analysis - quota may have been exhausted between check and decrement");
                    // This could happen if quota was exhausted between the check and decrement
                    // But don't fail the request since analysis succeeded
                } else {
                    console.log(`[Analyze-Image] Successfully decremented creation quota for user ${userId}`);
                }
            } else {
                // Unauthenticated users: track daily quota usage AFTER successful analysis
                console.log(`[Analyze-Image] Tracking daily quota usage for anonymous user (IP: ${identifier})`);
                // Increment daily quota tracking (1440 minute window = 24 hours)
                // This is the ONLY place we increment daily quota for unauthenticated users
                const dailyQuotaResult = await checkRateLimit(
                    supabaseAdmin,
                    identifier,
                    "analyze-image-daily",
                    10,
                    1440 // 24 hours in minutes
                );
                console.log(`[Analyze-Image] Daily quota tracked:`, {
                    remaining: dailyQuotaResult.remaining,
                    limit: dailyQuotaResult.limit,
                    resetAt: dailyQuotaResult.resetAt.toISOString(),
                });
            }

            // Track hourly rate limit usage AFTER successful analysis
            // This is the ONLY place we increment hourly rate limit - failed requests don't count
            const hourlyLimit = userId ? 50 : 10;
            const hourlyResult = await checkRateLimit(
                supabaseAdmin,
                identifier,
                "analyze-image",
                hourlyLimit,
                60 // 60 minutes
            );
            console.log(`[Analyze-Image] Hourly rate limit tracked after successful analysis:`, {
                remaining: hourlyResult.remaining,
                limit: hourlyResult.limit,
                resetAt: hourlyResult.resetAt.toISOString(),
            });

            // Update rate limit headers with incremented values for response
            rateLimitHeaders = getRateLimitHeaders(hourlyResult);

            // Track 15-minute rate limit usage AFTER successful analysis (for unauthenticated users only)
            // This is the ONLY place we increment 15-minute rate limit - failed requests don't count
            if (!userId) {
                const shortWindowResult = await checkRateLimit(
                    supabaseAdmin,
                    identifier,
                    "analyze-image-short",
                    5,
                    15 // 15 minutes
                );
                console.log(`[Analyze-Image] 15-minute rate limit tracked after successful analysis:`, {
                    remaining: shortWindowResult.remaining,
                    limit: shortWindowResult.limit,
                    resetAt: shortWindowResult.resetAt.toISOString(),
                });
            }
        }

        // Track success - non-blocking
        trackEvent(
            "api_analyze_success",
            { provider, has_title: Boolean(listing.title) },
            distinctId
        );

        // Get updated quota info after successful analysis and decrement
        let quota: any = null;
        let dailyQuotaInfo: { remaining: number; limit: number; resetAt: Date } | null = null;

        if (userId && supabaseUrl && supabaseServiceRoleKey) {
            // Authenticated users: get user quota
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
            const { data: quotaData, error: quotaFetchError } = await supabaseAdmin.rpc("get_user_quota", {
                p_user_id: userId,
            });

            if (quotaFetchError) {
                console.error("[Analyze-Image] Error fetching updated quota:", JSON.stringify(quotaFetchError, null, 2));
            } else {
                quota = quotaData?.[0];
                console.log(`[Analyze-Image] Quota after decrement:`, {
                    creations_remaining_today: quota?.creations_remaining_today,
                    bonus_creations_remaining: quota?.bonus_creations_remaining,
                });
            }
        } else if (supabaseUrl && supabaseServiceRoleKey) {
            // Unauthenticated users: get daily quota info
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
            const identifier = getRateLimitIdentifier(req, userId);
            const dailyQuotaResult = await checkRateLimit(
                supabaseAdmin,
                identifier,
                "analyze-image-daily",
                10,
                1440 // 24 hours in minutes
            );
            dailyQuotaInfo = {
                remaining: dailyQuotaResult.remaining,
                limit: dailyQuotaResult.limit,
                resetAt: dailyQuotaResult.resetAt,
            };
            console.log(`[Analyze-Image] Daily quota info for unauthenticated user:`, dailyQuotaInfo);
        }

        // Build response with listing and quota
        const responseData: any = listing;
        if (quota) {
            // Authenticated user quota
            responseData.quota = {
                creations_remaining_today: quota.creations_remaining_today ?? 0,
                creations_daily_limit: 10, // Default daily limit for free users
                bonus_creations_remaining: quota.bonus_creations_remaining ?? 0,
                save_slots_remaining: quota.save_slots_remaining ?? 0,
                is_pro: quota.is_pro ?? false,
            };
        } else if (dailyQuotaInfo) {
            // Unauthenticated user daily quota
            responseData.quota = {
                creations_remaining_today: dailyQuotaInfo.remaining,
                creations_daily_limit: dailyQuotaInfo.limit,
                bonus_creations_remaining: 0,
                save_slots_remaining: 0,
                is_pro: false,
                resets_at: dailyQuotaInfo.resetAt.toISOString(),
            };
        }

        return new Response(
            JSON.stringify(responseData),
            {
                status: 200,
                headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
            }
        );
    } catch (error: any) {
        const errorMessage = error?.message || String(error || "Unknown error");
        const errorStack = error?.stack || "no stack";
        const errorName = error?.name || error?.constructor?.name || "UnknownError";

        console.error("[Analyze-Image] Unexpected top-level error:", {
            errorMessage,
            errorName,
            errorStack: errorStack.substring(0, 1000), // Limit stack trace
            errorType: typeof error,
            errorKeys: error ? Object.keys(error) : [],
        });

        // Try to get rate limit headers even on error (readonly - don't increment for top-level errors)
        let rateLimitHeaders: Record<string, string> = {} as Record<string, string>;
        try {
            const supabaseUrl = Deno.env.get("SUPABASE_URL");
            const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
            if (supabaseUrl && supabaseServiceRoleKey) {
                const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
                const authHeader = req.headers.get("Authorization");
                let userId: string | undefined;
                if (authHeader) {
                    try {
                        const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
                        const supabaseClient = createClient(supabaseUrl, supabaseAnonKey || "", {
                            global: { headers: { Authorization: authHeader } },
                        });
                        const { data: { user } } = await supabaseClient.auth.getUser();
                        userId = user?.id;
                    } catch (e) {
                        // Ignore auth errors
                    }
                }
                const identifier = getRateLimitIdentifier(req, userId);
                const hourlyLimit = userId ? 50 : 10;
                const hourlyResult = await checkRateLimitReadonly(
                    supabaseAdmin,
                    identifier,
                    "analyze-image",
                    hourlyLimit,
                    60
                );
                rateLimitHeaders = getRateLimitHeaders(hourlyResult);
            }
        } catch (e) {
            // Ignore rate limit errors in error handler
            console.error("[Analyze-Image] Error getting rate limit headers in error handler:", e);
        }

        return new Response(
            JSON.stringify({
                detail: `Internal server error: ${errorMessage}`,
                code: "INTERNAL_SERVER_ERROR",
                error_name: errorName,
            }),
            {
                status: 500,
                headers: { ...corsHeaders, ...rateLimitHeaders, "Content-Type": "application/json" },
            }
        );
    }
});
