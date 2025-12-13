/**
 * Shared Rate Limiting Utility
 *
 * Provides rate limiting functionality for Supabase Edge Functions
 * Uses the rate_limits database table to track and enforce limits
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  limit: number;
}

export interface RateLimitHeaders {
  "X-RateLimit-Limit": string;
  "X-RateLimit-Remaining": string;
  "X-RateLimit-Reset": string;
  "Retry-After"?: string;
}

/**
 * Check rate limit for a given identifier and endpoint (READ-ONLY - doesn't increment)
 * Use this for checking quota/limits before processing
 *
 * @param supabaseAdmin - Supabase admin client (with service role key)
 * @param identifier - IP address or user_id
 * @param endpoint - Endpoint name (e.g., 'analyze-image')
 * @param limit - Maximum requests allowed
 * @param windowMinutes - Time window in minutes
 * @returns Rate limit result with allowed status and metadata
 */
export async function checkRateLimitReadonly(
  supabaseAdmin: any,
  identifier: string,
  endpoint: string,
  limit: number,
  windowMinutes: number
): Promise<RateLimitResult> {
  const { data, error } = await supabaseAdmin.rpc("check_rate_limit_readonly", {
    p_identifier: identifier,
    p_endpoint: endpoint,
    p_limit: limit,
    p_window_minutes: windowMinutes,
  });

  if (error) {
    console.error("Rate limit readonly check error:", error);
    // On error, allow the request (fail open) but log the error
    const resetAt = new Date(Date.now() + windowMinutes * 60 * 1000);
    return {
      allowed: true,
      remaining: limit,
      resetAt,
      limit,
    };
  }

  const result = data?.[0];
  if (!result) {
    // If no result, allow the request (fail open)
    const resetAt = new Date(Date.now() + windowMinutes * 60 * 1000);
    return {
      allowed: true,
      remaining: limit,
      resetAt,
      limit,
    };
  }

  return {
    allowed: result.allowed,
    remaining: result.remaining || 0,
    resetAt: new Date(result.reset_at),
    limit,
  };
}

/**
 * Check rate limit for a given identifier and endpoint (INCREMENTS counter)
 * Use this for tracking usage after successful operations
 *
 * @param supabaseAdmin - Supabase admin client (with service role key)
 * @param identifier - IP address or user_id
 * @param endpoint - Endpoint name (e.g., 'analyze-image')
 * @param limit - Maximum requests allowed
 * @param windowMinutes - Time window in minutes
 * @returns Rate limit result with allowed status and metadata
 */
export async function checkRateLimit(
  supabaseAdmin: any,
  identifier: string,
  endpoint: string,
  limit: number,
  windowMinutes: number
): Promise<RateLimitResult> {
  const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
    p_identifier: identifier,
    p_endpoint: endpoint,
    p_limit: limit,
    p_window_minutes: windowMinutes,
  });

  if (error) {
    console.error("Rate limit check error:", error);
    // On error, allow the request (fail open) but log the error
    const resetAt = new Date(Date.now() + windowMinutes * 60 * 1000);
    return {
      allowed: true,
      remaining: limit,
      resetAt,
      limit,
    };
  }

  const result = data?.[0];
  if (!result) {
    // If no result, allow the request (fail open)
    const resetAt = new Date(Date.now() + windowMinutes * 60 * 1000);
    return {
      allowed: true,
      remaining: limit,
      resetAt,
      limit,
    };
  }

  return {
    allowed: result.allowed,
    remaining: result.remaining || 0,
    resetAt: new Date(result.reset_at),
    limit,
  };
}

/**
 * Generate rate limit response headers
 *
 * @param result - Rate limit result
 * @returns Headers object with rate limit information
 */
export function getRateLimitHeaders(result: RateLimitResult): RateLimitHeaders {
  const headers: RateLimitHeaders = {
    "X-RateLimit-Limit": result.limit.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": Math.floor(result.resetAt.getTime() / 1000).toString(),
  };

  // Add Retry-After header if rate limited
  if (!result.allowed) {
    const retryAfterSeconds = Math.ceil(
      (result.resetAt.getTime() - Date.now()) / 1000
    );
    headers["Retry-After"] = Math.max(0, retryAfterSeconds).toString();
  }

  return headers;
}

/**
 * Get identifier from request (IP address or user ID)
 *
 * @param req - Request object
 * @param userId - Optional user ID if authenticated
 * @returns Identifier string (IP address or user_id)
 */
export function getRateLimitIdentifier(req: Request, userId?: string): string {
  // Use user_id if authenticated, otherwise use IP address
  if (userId) {
    return `user:${userId}`;
  }

  // Extract IP address from headers
  const forwardedFor = req.headers.get("x-forwarded-for");
  const realIp = req.headers.get("x-real-ip");
  const ip = forwardedFor
    ? forwardedFor.split(",")[0].trim()
    : realIp || "unknown";

  return `ip:${ip}`;
}

/**
 * Create rate limit error response
 *
 * @param result - Rate limit result
 * @param corsHeaders - CORS headers to include
 * @returns Response object with 429 status
 */
export function createRateLimitErrorResponse(
  result: RateLimitResult,
  corsHeaders: Record<string, string>
): Response {
  const headers = getRateLimitHeaders(result);
  const retryAfterSeconds = Math.ceil(
    (result.resetAt.getTime() - Date.now()) / 1000
  );

  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded. Please try again later or sign in for higher limits.",
      code: "RATE_LIMIT_EXCEEDED",
      remaining: result.remaining,
      limit: result.limit,
      retry_after: Math.max(0, retryAfterSeconds),
      resets_at: result.resetAt.toISOString(),
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        ...headers,
        "Content-Type": "application/json",
      },
    }
  );
}
