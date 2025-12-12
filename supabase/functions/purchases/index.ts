import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

interface PurchaseRequest {
  sku: string; // 'credits_10', 'credits_25', 'credits_60'
  idempotency_key: string;
  success_url?: string;
  cancel_url?: string;
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

    // Get Supabase clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
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
    const body: PurchaseRequest = await req.json();

    if (!body.sku || !body.idempotency_key) {
      return new Response(
        JSON.stringify({ error: "sku and idempotency_key are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check idempotency - if purchase already completed, return existing result
    const { data: existingPurchase } = await supabaseAdmin.rpc(
      "check_purchase_idempotency",
      {
        p_idempotency_key: body.idempotency_key,
      }
    );

    if (existingPurchase && existingPurchase.status === "completed") {
      // Get the Stripe session if it exists
      const { data: purchaseRecord } = await supabaseAdmin
        .from("purchases")
        .select("stripe_session_id")
        .eq("idempotency_key", body.idempotency_key)
        .single();

      return new Response(
        JSON.stringify({
          message: "Purchase already completed",
          purchase_id: existingPurchase.id,
          status: existingPurchase.status,
          checkout_url: purchaseRecord?.stripe_session_id
            ? `https://checkout.stripe.com/pay/${purchaseRecord.stripe_session_id}`
            : null,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate pack exists and is active
    const { data: pack, error: packError } = await supabaseAdmin
      .from("packs")
      .select("*")
      .eq("sku", body.sku)
      .eq("active", true)
      .single();

    if (packError || !pack) {
      return new Response(
        JSON.stringify({ error: "Pack not found or inactive", sku: body.sku }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Stripe secret key (support test/sandbox mode)
    const stripeMode = Deno.env.get("STRIPE_MODE") || "production";
    const stripeSecretKey = stripeMode === "test"
      ? (Deno.env.get("STRIPE_SECRET_KEY_SANDBOX") || Deno.env.get("STRIPE_SECRET_KEY"))
      : Deno.env.get("STRIPE_SECRET_KEY");

    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "Stripe not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get product/price mappings (support test/sandbox mode)
    const mappingKey = stripeMode === "test"
      ? "STRIPE_PRODUCTS_MAPPING_SANDBOX"
      : "STRIPE_PRODUCTS_MAPPING";

    const productsMappingStr = Deno.env.get(mappingKey) || Deno.env.get("STRIPE_PRODUCTS_MAPPING");
    let productsMapping: Record<string, any> = {};

    if (productsMappingStr) {
      try {
        productsMapping = JSON.parse(productsMappingStr);
      } catch (e) {
        console.error(`Failed to parse ${mappingKey}:`, e);
      }
    }

    // Get price_id from pack or mapping
    let priceId: string | undefined = pack.stripe_price_id;

    if (!priceId) {
      // Fallback to mapping
      const mapping = productsMapping[body.sku];
      if (mapping && mapping.price_id) {
        priceId = mapping.price_id;
      }
    }

    if (!priceId) {
      return new Response(
        JSON.stringify({ error: `Price ID not configured for pack ${body.sku}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get success/cancel URLs
    const successUrl = body.success_url || `https://checkout.stripe.com/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = body.cancel_url || `https://checkout.stripe.com/cancel`;

    // Extract credits amount from SKU (e.g., 'credits_25' -> 25)
    const creditsMatch = body.sku.match(/credits_(\d+)/);
    const creditsAmount = creditsMatch ? creditsMatch[1] : "0";

    // Create Stripe checkout session
    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "mode": "payment",
        "payment_method_types[]": "card",
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        "success_url": successUrl,
        "cancel_url": cancelUrl,
        "client_reference_id": user.id,
        "metadata[user_id]": user.id,
        "metadata[type]": "credits",
        "metadata[sku]": body.sku,
        "metadata[credits]": creditsAmount,
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

    // Create pending purchase record
    const { data: purchase, error: purchaseError } = await supabaseAdmin
      .from("purchases")
      .insert({
        user_id: user.id,
        sku: body.sku,
        amount_cents: session.amount_total || 0,
        status: "pending",
        idempotency_key: body.idempotency_key,
        stripe_session_id: session.id,
        metadata: {
          type: "credits",
          credits: creditsAmount,
        },
      })
      .select()
      .single();

    if (purchaseError) {
      console.error("Failed to create purchase record:", purchaseError);
      // Continue anyway - webhook will handle it
    }

    // Track analytics
    await supabaseAdmin.from("usage_logs").insert({
      user_id: user.id,
      action: "purchase_credits",
      meta: { sku: body.sku, pack_purchase_initiated: true },
    }).catch((err) => console.error("Analytics error:", err));

    return new Response(
      JSON.stringify({
        checkout_url: session.url,
        session_id: session.id,
        purchase_id: purchase?.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Purchase creation error:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to create purchase",
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
