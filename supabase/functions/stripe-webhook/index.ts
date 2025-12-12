import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// Stripe webhook signature verification using HMAC
async function verifyStripeSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    // Stripe sends signatures in format: t=timestamp,v1=signature,v0=signature
    // We need to extract the v1 signature
    const elements = signature.split(',');
    const sigHeader: Record<string, string> = {};

    for (const element of elements) {
      const [key, value] = element.split('=');
      sigHeader[key] = value;
    }

    const timestamp = sigHeader.t;
    const signatureToVerify = sigHeader.v1;

    if (!timestamp || !signatureToVerify) {
      return false;
    }

    // Create the signed payload
    const signedPayload = `${timestamp}.${payload}`;

    // Compute HMAC
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBytes = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(signedPayload)
    );

    // Convert to hex
    const computedSignature = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Compare signatures using constant-time comparison
    if (computedSignature.length !== signatureToVerify.length) {
      return false;
    }

    let match = 0;
    for (let i = 0; i < computedSignature.length; i++) {
      match |= computedSignature.charCodeAt(i) ^ signatureToVerify.charCodeAt(i);
    }

    return match === 0;
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean; // false = test mode, true = live mode
  data: {
    object: any;
  };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get Stripe signature - webhooks don't use Authorization headers
    const signature = req.headers.get("stripe-signature");

    // Support test/sandbox mode for webhook secret
    const stripeMode = Deno.env.get("STRIPE_MODE") || "production";
    const webhookSecret = stripeMode === "test"
      ? (Deno.env.get("STRIPE_WEBHOOK_SECRET_SANDBOX") || Deno.env.get("STRIPE_WEBHOOK_SECRET"))
      : Deno.env.get("STRIPE_WEBHOOK_SECRET");

    // Log for debugging (remove in production or use proper logging)
    console.log("Webhook received:", {
      method: req.method,
      mode: stripeMode,
      hasSignature: !!signature,
      hasSecret: !!webhookSecret,
      headers: Object.fromEntries(req.headers.entries()),
    });

    if (!signature) {
      console.error("Missing stripe-signature header");
      return new Response(
        JSON.stringify({
          error: "Missing stripe-signature header",
          message: "Stripe webhooks require the stripe-signature header"
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!webhookSecret) {
      console.error("Missing STRIPE_WEBHOOK_SECRET environment variable");
      return new Response(
        JSON.stringify({
          error: "Server configuration error",
          message: "STRIPE_WEBHOOK_SECRET not configured"
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get raw body for signature verification
    const body = await req.text();

    // Verify signature
    const isValid = await verifyStripeSignature(body, signature, webhookSecret);
    if (!isValid) {
      console.error("Invalid signature verification");
      return new Response(
        JSON.stringify({
          error: "Invalid signature",
          message: "Webhook signature verification failed"
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse event
    const event: StripeEvent = JSON.parse(body);

    // Use built-in Supabase environment variables (automatically available in Edge Functions)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      console.error("Missing Supabase configuration:", {
        hasUrl: !!supabaseUrl,
        hasServiceRoleKey: !!supabaseServiceRoleKey,
      });
      return new Response(
        JSON.stringify({ error: "Server configuration error", message: "Supabase environment variables are not available." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Get product/price mappings for credit calculation (support test/sandbox mode)
    // Format: JSON string with mapping of product_id or price_id to credits
    const stripeMode = Deno.env.get("STRIPE_MODE") || "production"; // "test" or "production"
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

    // Helper function to get credits from product/price mapping
    function getCreditsFromMapping(productId?: string, priceId?: string): number | null {
      if (!productId && !priceId) return null;

      // Check price_id first (more specific)
      if (priceId && productsMapping[priceId]) {
        const mapping = productsMapping[priceId];
        return mapping.credits || null;
      }

      // Check product_id
      if (productId) {
        // Try direct product_id match
        if (productsMapping[productId]) {
          const mapping = productsMapping[productId];
          return mapping.credits || null;
        }

        // Try matching by product_id in nested structure
        for (const key in productsMapping) {
          if (productsMapping[key].product_id === productId) {
            return productsMapping[key].credits || null;
          }
        }
      }

      return null;
    }

    // Handle different event types
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const clientReferenceId = session.client_reference_id; // User ID
        const amountTotal = session.amount_total || 0; // Amount in cents
        const currency = session.currency || 'usd';

        // Get user ID from metadata or client_reference_id
        let userId = clientReferenceId;

        // If no client_reference_id, try to find user by email
        if (!userId && session.customer_email) {
          const { data: authUser } = await supabaseAdmin.auth.admin.listUsers();
          const user = authUser.users.find((u) => u.email === session.customer_email);
          userId = user?.id;
        }

        if (!userId) {
          console.error("Could not find user for checkout session:", session.id);
          return new Response(
            JSON.stringify({ error: "User not found" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Check if this payment was already processed (idempotency)
        const { data: existingPayment } = await supabaseAdmin
          .from("stripe_payments")
          .select("id, status")
          .eq("stripe_session_id", session.id)
          .single();

        if (existingPayment && existingPayment.status === 'completed') {
          console.log("Payment already processed:", session.id);
          return new Response(
            JSON.stringify({ received: true, message: "Already processed" }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Handle subscription creation
        if (subscriptionId) {
          // Get subscription details from Stripe API (we'll need to fetch it)
          // For now, create a basic subscription record
          const { error: subError } = await supabaseAdmin
            .from("subscriptions")
            .upsert(
              {
                user_id: userId,
                stripe_customer_id: customerId,
                stripe_subscription_id: subscriptionId,
                status: "active",
                current_period_start: new Date().toISOString(),
                current_period_end: new Date(
                  Date.now() + 30 * 24 * 60 * 60 * 1000
                ).toISOString(), // 30 days from now
              },
              { onConflict: "stripe_subscription_id" }
            );

          if (subError) {
            console.error("Subscription creation error:", subError);
          } else {
            // Update user plan to 'pro'
            await supabaseAdmin
              .from("users_profile")
              .update({ plan: "pro" })
              .eq("id", userId);

            // Record payment
            await supabaseAdmin
              .from("stripe_payments")
              .insert({
                user_id: userId,
                stripe_session_id: session.id,
                stripe_customer_id: customerId,
                amount: amountTotal,
                currency: currency,
                type: 'subscription',
                status: 'completed',
                metadata: { subscription_id: subscriptionId, ...session.metadata },
              });

            // Log usage
            await supabaseAdmin
              .from("usage_logs")
              .insert({
                user_id: userId,
                action: 'purchase_credits',
                meta: { type: 'subscription', subscription_id: subscriptionId },
              });
          }
        } else {
          // Handle credit purchase (one-time payment)
          // First, try to get credits from metadata
          let creditsAmount = session.metadata?.credits;

          // If not in metadata, try to get from line items via product/price mapping
          if (!creditsAmount && session.line_items?.data) {
            const lineItems = session.line_items.data;
            for (const item of lineItems) {
              const productId = item.price?.product;
              const priceId = item.price?.id;
              const mappedCredits = getCreditsFromMapping(productId, priceId);
              if (mappedCredits) {
                creditsAmount = mappedCredits.toString();
                break;
              }
            }
          }

          // Fallback: try to infer from amount (if mapping not available)
          if (!creditsAmount) {
            // Rough mapping: $5 = 10 credits, $10 = 25 credits, $20 = 60 credits
            const amountDollars = amountTotal / 100;
            if (amountDollars >= 19) creditsAmount = "60";
            else if (amountDollars >= 9) creditsAmount = "25";
            else if (amountDollars >= 4) creditsAmount = "10";
          }

          if (creditsAmount) {
            const credits = parseInt(creditsAmount, 10);
            if (credits > 0) {
              // Increment credits
              await supabaseAdmin.rpc("increment_credits", {
                p_user_id: userId,
                p_amount: credits,
              }).catch(async () => {
                // Fallback if function doesn't exist
                const { data: profile } = await supabaseAdmin
                  .from("users_profile")
                  .select("credits")
                  .eq("id", userId)
                  .single();

                await supabaseAdmin
                  .from("users_profile")
                  .update({ credits: (profile?.credits || 0) + credits })
                  .eq("id", userId);
              });

              // Record payment
              await supabaseAdmin
                .from("stripe_payments")
                .insert({
                  user_id: userId,
                  stripe_session_id: session.id,
                  stripe_customer_id: customerId,
                  amount: amountTotal,
                  currency: currency,
                  type: 'credits',
                  credits: credits,
                  status: 'completed',
                  metadata: session.metadata || {},
                });

              // Log usage
              await supabaseAdmin
                .from("usage_logs")
                .insert({
                  user_id: userId,
                  action: 'purchase_credits',
                  meta: { type: 'credits', credits: credits, amount: amountTotal },
                });

              console.log(`Added ${credits} credits to user ${userId}`);
            }
          } else {
            console.warn("No credits amount found for checkout session:", session.id);
          }
        }

        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;
        const status = subscription.status;
        const customerId = subscription.customer;

        // Find subscription record
        const { data: existingSub } = await supabaseAdmin
          .from("subscriptions")
          .select("user_id")
          .eq("stripe_subscription_id", subscriptionId)
          .single();

        if (existingSub) {
          await supabaseAdmin
            .from("subscriptions")
            .update({
              status: status,
              current_period_start: new Date(
                subscription.current_period_start * 1000
              ).toISOString(),
              current_period_end: new Date(
                subscription.current_period_end * 1000
              ).toISOString(),
            })
            .eq("stripe_subscription_id", subscriptionId);

          // Update user plan based on status
          if (status === "active" || status === "trialing") {
            await supabaseAdmin
              .from("users_profile")
              .update({ plan: "pro" })
              .eq("id", existingSub.user_id);
          } else if (status === "canceled" || status === "past_due") {
            await supabaseAdmin
              .from("users_profile")
              .update({ plan: "free" })
              .eq("id", existingSub.user_id);
          }
        }

        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;

        const { data: existingSub } = await supabaseAdmin
          .from("subscriptions")
          .select("user_id")
          .eq("stripe_subscription_id", subscriptionId)
          .single();

        if (existingSub) {
          await supabaseAdmin
            .from("subscriptions")
            .update({ status: "canceled" })
            .eq("stripe_subscription_id", subscriptionId);

          await supabaseAdmin
            .from("users_profile")
            .update({ plan: "free" })
            .eq("id", existingSub.user_id);
        }

        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;
        const amountPaid = invoice.amount_paid || 0;
        const currency = invoice.currency || 'usd';

        // Handle credit purchases from invoice metadata or line items
        let creditsAmount = invoice.metadata?.credits;

        // If no credits in metadata, try to get from line items via product/price mapping
        if (!creditsAmount && invoice.lines?.data) {
          const lineItems = invoice.lines.data;
          for (const item of lineItems) {
            const productId = item.price?.product;
            const priceId = item.price?.id;
            const mappedCredits = getCreditsFromMapping(productId, priceId);
            if (mappedCredits) {
              creditsAmount = mappedCredits.toString();
              break;
            }
          }
        }

        if (creditsAmount) {
          const credits = parseInt(creditsAmount, 10);
          if (credits > 0) {
            // Find user by customer ID
            const { data: sub } = await supabaseAdmin
              .from("subscriptions")
              .select("user_id")
              .eq("stripe_customer_id", customerId)
              .single();

            if (sub) {
              // Increment credits
              await supabaseAdmin.rpc("increment_credits", {
                p_user_id: sub.user_id,
                p_amount: credits,
              }).catch(async () => {
                // Fallback if function doesn't exist
                const { data: profile } = await supabaseAdmin
                  .from("users_profile")
                  .select("credits")
                  .eq("id", sub.user_id)
                  .single();

                await supabaseAdmin
                  .from("users_profile")
                  .update({ credits: (profile?.credits || 0) + credits })
                  .eq("id", sub.user_id);
              });

              // Record payment (if not subscription-related)
              if (!subscriptionId) {
                await supabaseAdmin
                  .from("stripe_payments")
                  .insert({
                    user_id: sub.user_id,
                    stripe_payment_intent_id: invoice.payment_intent,
                    stripe_customer_id: customerId,
                    amount: amountPaid,
                    currency: currency,
                    type: 'credits',
                    credits: credits,
                    status: 'completed',
                    metadata: invoice.metadata || {},
                  });
              }
            }
          }
        }

        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(
      JSON.stringify({ received: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(
      JSON.stringify({ error: "Webhook processing failed", details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
