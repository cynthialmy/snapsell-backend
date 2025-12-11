import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

interface CheckoutRequest {
  type: "credits" | "subscription";
  credits?: 10 | 25 | 60;
  subscription_plan?: "monthly" | "yearly";
  user_id: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    // Verify user
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

    // Parse request body
    const body: CheckoutRequest = await req.json();

    // Validate request
    if (body.type === "credits" && !body.credits) {
      return new Response(
        JSON.stringify({ error: "Credits amount required for credits purchase" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.type === "subscription" && !body.subscription_plan) {
      return new Response(
        JSON.stringify({ error: "Subscription plan required for subscription purchase" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify user_id matches authenticated user
    if (body.user_id !== user.id) {
      return new Response(
        JSON.stringify({ error: "User ID mismatch" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Stripe secret key
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "Stripe not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get product/price mappings
    const productsMappingStr = Deno.env.get("STRIPE_PRODUCTS_MAPPING");
    let productsMapping: Record<string, any> = {};

    if (productsMappingStr) {
      try {
        productsMapping = JSON.parse(productsMappingStr);
      } catch (e) {
        console.error("Failed to parse STRIPE_PRODUCTS_MAPPING:", e);
      }
    }

    // Get base URL for success/cancel URLs
    const baseUrl = Deno.env.get("SUPABASE_URL")?.replace("/rest/v1", "") || "";
    const successUrl = `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/payment/cancel`;

    let priceId: string | undefined;
    let metadata: Record<string, string> = {
      user_id: user.id,
      type: body.type,
    };

    if (body.type === "credits") {
      // Get price ID for credit pack
      const mappingKey = `credits_${body.credits}`;
      const mapping = productsMapping[mappingKey];

      if (!mapping || !mapping.price_id) {
        return new Response(
          JSON.stringify({ error: `Price ID not configured for ${mappingKey}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      priceId = mapping.price_id;
      metadata.credits = body.credits.toString();
    } else if (body.type === "subscription") {
      // Get price ID for subscription
      const mappingKey = `pro_${body.subscription_plan}`;
      const mapping = productsMapping[mappingKey];

      if (!mapping || !mapping.price_id) {
        return new Response(
          JSON.stringify({ error: `Price ID not configured for ${mappingKey}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      priceId = mapping.price_id;
      metadata.subscription_plan = body.subscription_plan;
    }

    // Create Stripe checkout session via Stripe API
    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "mode": body.type === "subscription" ? "subscription" : "payment",
        "payment_method_types[]": "card",
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        "success_url": successUrl,
        "cancel_url": cancelUrl,
        "client_reference_id": user.id,
        "metadata[user_id]": user.id,
        "metadata[type]": body.type,
        ...(body.type === "credits" ? { "metadata[credits]": body.credits!.toString() } : {}),
        ...(body.type === "subscription" ? { "metadata[subscription_plan]": body.subscription_plan! } : {}),
      }).toString(),
    });

    if (!stripeResponse.ok) {
      const error = await stripeResponse.text();
      console.error("Stripe API error:", error);
      return new Response(
        JSON.stringify({ error: "Failed to create checkout session", details: error }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const session = await stripeResponse.json();

    // Record pending payment
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseServiceRoleKey) {
      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
      await supabaseAdmin
        .from("stripe_payments")
        .insert({
          user_id: user.id,
          stripe_session_id: session.id,
          amount: session.amount_total || 0,
          currency: session.currency || 'usd',
          type: body.type,
          credits: body.type === "credits" ? body.credits : 0,
          status: 'pending',
          metadata: metadata,
        });
    }

    return new Response(
      JSON.stringify({
        checkout_url: session.url,
        session_id: session.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Checkout session creation error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to create checkout session", details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
