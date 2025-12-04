import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// Stripe webhook signature verification
// Note: In production, use Stripe's official SDK for signature verification
async function verifyStripeSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  // TODO: Implement proper Stripe signature verification
  // For now, we'll use a simple check with the webhook secret
  // In production, use: https://github.com/stripe/stripe-node
  return true; // Stub - implement proper verification
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
    // Get Stripe signature
    const signature = req.headers.get("stripe-signature");
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

    if (!signature || !webhookSecret) {
      return new Response(
        JSON.stringify({ error: "Missing signature or webhook secret" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get raw body for signature verification
    const body = await req.text();

    // Verify signature (stub - implement properly in production)
    const isValid = await verifyStripeSignature(body, signature, webhookSecret);
    if (!isValid) {
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse event
    const event: StripeEvent = JSON.parse(body);

    // Create Supabase admin client
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SECRET_KEY") ?? ""
    );

    // Handle different event types
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const clientReferenceId = session.client_reference_id; // User ID

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

        // Handle credit purchases from invoice metadata
        const creditsAmount = invoice.metadata?.credits;
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
