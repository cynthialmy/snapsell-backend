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
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

    // Log for debugging (remove in production or use proper logging)
    console.log("Webhook received:", {
      method: req.method,
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

    // Create Supabase admin client
    // Use SUPABASE_SERVICE_ROLE_KEY (legacy name) or SUPABASE_SECRET_KEY
    const supabaseKey = Deno.env.get("SUPABASE_SECRET_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing Supabase configuration:", {
        hasUrl: !!supabaseUrl,
        hasKey: !!supabaseKey,
      });
      return new Response(
        JSON.stringify({ error: "Server configuration error", message: "Missing Supabase URL or secret key" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

    // Get configured product ID (for KoFi/Stripe integration)
    const expectedProductId = Deno.env.get("STRIPE_PRODUCT_ID");

    // Handle different event types
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const clientReferenceId = session.client_reference_id; // User ID

        // Optional: Validate product ID if configured (for KoFi integration)
        if (expectedProductId && session.metadata?.product_id !== expectedProductId) {
          // Check line items for product ID
          const lineItems = session.line_items || [];
          const hasMatchingProduct = lineItems.some(
            (item: any) => item.price?.product === expectedProductId
          );

          // If product ID doesn't match and we have one configured, log but continue
          // (KoFi may pass product ID in different fields)
          if (!hasMatchingProduct && session.metadata?.product_id) {
            console.log("Product ID mismatch, but continuing:", {
              expected: expectedProductId,
              received: session.metadata?.product_id,
            });
          }
        }

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

        // Handle subscription creation
        if (subscriptionId) {
          // Get subscription details from Stripe (would need Stripe SDK)
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
          }

          // Update user plan to 'pro'
          await supabaseAdmin
            .from("users_profile")
            .update({ plan: "pro" })
            .eq("id", userId);
        }

        // Handle credit purchase (check for metadata)
        const creditsAmount = session.metadata?.credits;
        if (creditsAmount) {
          const credits = parseInt(creditsAmount, 10);
          if (credits > 0) {
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

        // Handle credit purchases from invoice metadata or line items
        // KoFi may pass credits in metadata or we can derive from product
        let creditsAmount = invoice.metadata?.credits;

        // If no credits in metadata, check line items for product-based credits
        if (!creditsAmount && expectedProductId) {
          const lineItems = invoice.lines?.data || [];
          const matchingItem = lineItems.find(
            (item: any) => item.price?.product === expectedProductId
          );
          // You can map product to credits here if needed
          // For now, we'll rely on metadata
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
              const { data: profile } = await supabaseAdmin
                .from("users_profile")
                .select("credits")
                .eq("id", sub.user_id)
                .single();

              await supabaseAdmin
                .from("users_profile")
                .update({ credits: (profile?.credits || 0) + credits })
                .eq("id", sub.user_id);
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
