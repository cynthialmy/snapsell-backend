import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=denonext";
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
      console.error("Missing timestamp or signature in stripe-signature header");
      return false;
    }

    // Decode webhook secret if it starts with whsec_ (base64 encoded)
    let decodedSecret: string;
    if (secret.startsWith('whsec_')) {
      try {
        // Remove whsec_ prefix and decode base64
        const base64Secret = secret.substring(6);
        decodedSecret = atob(base64Secret);
      } catch (e) {
        console.error("Failed to decode webhook secret:", e);
        return false;
      }
    } else {
      // Use secret as-is if it doesn't start with whsec_
      decodedSecret = secret;
    }

    // Create the signed payload
    const signedPayload = `${timestamp}.${payload}`;

    // Compute HMAC
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(decodedSecret),
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

// Using Stripe.Event type from SDK instead of custom interface

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
      webhookSecretPrefix: webhookSecret ? webhookSecret.substring(0, 10) + "..." : null,
      signaturePrefix: signature ? signature.substring(0, 30) + "..." : null,
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

    // Verify signature using Stripe SDK (handles whsec_ decoding automatically)
    // Create Stripe instance for webhook verification (API key not needed for webhooks)
    const stripeSecretKey = stripeMode === "test"
      ? (Deno.env.get("STRIPE_SECRET_KEY_SANDBOX") || Deno.env.get("STRIPE_SECRET_KEY"))
      : Deno.env.get("STRIPE_SECRET_KEY");

    const stripe = stripeSecretKey
      ? new Stripe(stripeSecretKey, { apiVersion: '2024-11-20.acacia' })
      : null;

    let event: Stripe.Event;
    try {
      if (stripe) {
        // Use Stripe SDK for verification (handles whsec_ decoding)
        const cryptoProvider = Stripe.createSubtleCryptoProvider();
        event = await stripe.webhooks.constructEventAsync(
          body,
          signature,
          webhookSecret,
          undefined,
          cryptoProvider
        );
      } else {
        // Fallback to manual verification if Stripe SDK not available
        const isValid = await verifyStripeSignature(body, signature, webhookSecret);
        if (!isValid) {
          throw new Error("Manual signature verification failed");
        }
        event = JSON.parse(body) as Stripe.Event;
      }
    } catch (err: any) {
      console.error("Stripe webhook signature verification failed:", {
        error: err.message,
        signature_length: signature?.length,
        body_length: body.length,
        has_webhook_secret: !!webhookSecret,
        webhook_secret_length: webhookSecret?.length,
        webhook_secret_starts_with_whsec: webhookSecret?.startsWith('whsec_'),
        signature_preview: signature?.substring(0, 30) + "...",
        using_stripe_sdk: !!stripe,
      });

      // Try manual verification as fallback
      const isValid = await verifyStripeSignature(body, signature, webhookSecret);
      if (!isValid) {
        return new Response(
          JSON.stringify({
            error: "Invalid signature",
            message: "Webhook signature verification failed. Check that STRIPE_WEBHOOK_SECRET matches the webhook endpoint secret in Stripe Dashboard.",
            details: err.message
          }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // If manual verification passed, parse event manually
      event = JSON.parse(body) as Stripe.Event;
    }

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
    // Reuse stripeMode from above
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
    const eventType = event.type as string;
    switch (eventType) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const clientReferenceId = session.client_reference_id; // User ID
        const amountTotal = session.amount_total || 0; // Amount in cents
        const currency = session.currency || 'usd';

        console.log("Processing checkout.session.completed:", {
          session_id: session.id,
          customer_id: customerId,
          subscription_id: subscriptionId,
          client_reference_id: clientReferenceId,
          amount_total: amountTotal,
          metadata: session.metadata,
        });

        // Get user ID from metadata or client_reference_id
        let userId = clientReferenceId || session.metadata?.user_id;

        // If no client_reference_id, try to find user by email
        if (!userId && session.customer_email) {
          const { data: authUser } = await supabaseAdmin.auth.admin.listUsers();
          const user = authUser.users.find((u) => u.email === session.customer_email);
          userId = user?.id;
        }

        if (!userId) {
          console.error("Could not find user for checkout session:", {
            session_id: session.id,
            customer_email: session.customer_email,
            client_reference_id: clientReferenceId,
            metadata: session.metadata,
          });
          return new Response(
            JSON.stringify({ error: "User not found" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Verify user exists in auth.users
        const { data: authUser, error: authUserError } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (authUserError || !authUser) {
          console.error("User not found in auth.users:", {
            user_id: userId,
            error: authUserError,
          });
          return new Response(
            JSON.stringify({ error: "User not found in auth system" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Ensure users_profile exists (in case trigger failed)
        const { error: ensureProfileError } = await supabaseAdmin.rpc("ensure_users_profile_exists", {
          p_user_id: userId,
        });
        if (ensureProfileError) {
          console.error("Failed to ensure users_profile exists:", ensureProfileError);
          // Continue anyway - we'll handle it in credit increment
        }

        // Check if this payment was already processed (idempotency)
        const { data: existingPayment } = await supabaseAdmin
          .from("stripe_payments")
          .select("id, status, credits")
          .eq("stripe_session_id", session.id)
          .single();

        if (existingPayment && existingPayment.status === 'completed') {
          console.log("Payment already processed:", {
            session_id: session.id,
            existing_credits: existingPayment.credits,
          });

          // If credits weren't added before (0 or NULL), try to add them now
          if (!existingPayment.credits || existingPayment.credits === 0) {
            console.log("Payment completed but credits missing, attempting to fix...");
            // Try to determine credits from metadata or amount
            let creditsToAdd = session.metadata?.credits
              ? parseInt(session.metadata.credits, 10)
              : null;

            if (!creditsToAdd) {
              // Fallback: infer from amount
              const amountDollars = amountTotal / 100;
              if (amountDollars >= 19) creditsToAdd = 60;
              else if (amountDollars >= 9) creditsToAdd = 25;
              else if (amountDollars >= 4) creditsToAdd = 10;
            }

            if (creditsToAdd && creditsToAdd > 0) {
              // Use safe_increment_credits which ensures profile exists
              const { data: creditResult, error: creditError } = await supabaseAdmin.rpc("safe_increment_credits", {
                p_user_id: userId,
                p_amount: creditsToAdd,
              });

              if (creditError || !creditResult?.success) {
                console.error("Failed to increment credits for existing payment:", {
                  error: creditError,
                  result: creditResult,
                });
                // Try fallback
                const { error: fallbackError } = await supabaseAdmin.rpc("increment_credits", {
                  p_user_id: userId,
                  p_amount: creditsToAdd,
                });
                if (fallbackError) {
                  console.error("Fallback increment_credits also failed:", fallbackError);
                }
              } else {
                // Update payment record with credits
                const { error: updateError } = await supabaseAdmin
                  .from("stripe_payments")
                  .update({ credits: creditsToAdd })
                  .eq("id", existingPayment.id);

                if (updateError) {
                  console.error("Failed to update payment record with credits:", updateError);
                } else {
                  console.log(`Fixed missing credits: Added ${creditsToAdd} credits to user ${userId}`, creditResult);
                }
              }
            } else {
              console.warn("Could not determine credits to add for existing payment");
            }
          } else if (existingPayment.credits > 0) {
            // Credits already added, but double-check they're in the user's account
            // (in case there was a race condition or error)
            const { error: creditError } = await supabaseAdmin.rpc("increment_credits", {
              p_user_id: userId,
              p_amount: existingPayment.credits,
            });
            // Silently ignore error if credits were already added (idempotent operation)
            if (!creditError) {
              console.log(`Verified credits for user ${userId}`);
            }
          }

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
          // Handle pack purchase (one-time payment)
          // Get SKU from metadata or infer from credits amount
          let sku = session.metadata?.sku;
          let creditsAmount = session.metadata?.credits;

          console.log("Pack purchase detected:", {
            session_id: session.id,
            metadata_sku: session.metadata?.sku,
            metadata_credits: session.metadata?.credits,
            has_line_items: !!session.line_items,
          });

          // If SKU not in metadata, try to get from line items via product/price mapping
          if (!sku) {
            // Try to get line items from the session (they might be expanded)
            if (session.line_items?.data) {
              const lineItems = session.line_items.data;
              for (const item of lineItems) {
                const productId = item.price?.product;
                const priceId = item.price?.id;
                console.log("Checking line item:", { productId, priceId });
                const mappedCredits = getCreditsFromMapping(productId, priceId);
                if (mappedCredits) {
                  sku = `credits_${mappedCredits}`;
                  creditsAmount = mappedCredits.toString();
                  console.log("Found SKU from mapping:", sku);
                  break;
                }
              }
            }

            // If still not found and we have a Stripe secret key, fetch the session with expanded line items
            if (!sku) {
              const stripeSecretKey = stripeMode === "test"
                ? (Deno.env.get("STRIPE_SECRET_KEY_SANDBOX") || Deno.env.get("STRIPE_SECRET_KEY"))
                : Deno.env.get("STRIPE_SECRET_KEY");

              if (stripeSecretKey) {
                try {
                  // Fetch session with expanded line items
                  const stripeResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session.id}?expand[]=line_items`, {
                    headers: {
                      "Authorization": `Bearer ${stripeSecretKey}`,
                    },
                  });

                  if (stripeResponse.ok) {
                    const expandedSession = await stripeResponse.json();
                    if (expandedSession.line_items?.data) {
                      const lineItems = expandedSession.line_items.data;
                      for (const item of lineItems) {
                        const productId = item.price?.product;
                        const priceId = item.price?.id;
                        console.log("Checking expanded line item:", { productId, priceId });
                        const mappedCredits = getCreditsFromMapping(productId, priceId);
                        if (mappedCredits) {
                          sku = `credits_${mappedCredits}`;
                          creditsAmount = mappedCredits.toString();
                          console.log("Found SKU from expanded line items:", sku);
                          break;
                        }
                      }
                    }
                  }
                } catch (error) {
                  console.error("Failed to fetch expanded session:", error);
                }
              }
            }
          }

          // Fallback: try to infer SKU from amount (if mapping not available)
          if (!sku) {
            // Rough mapping: $5 = 10 credits, $10 = 25 credits, $20 = 60 credits
            const amountDollars = amountTotal / 100;
            if (amountDollars >= 19) {
              sku = "credits_60";
              creditsAmount = "60";
            } else if (amountDollars >= 9) {
              sku = "credits_25";
              creditsAmount = "25";
            } else if (amountDollars >= 4) {
              sku = "credits_10";
              creditsAmount = "10";
            }
            console.log("Using fallback SKU inference:", { amountDollars, sku });
          }

          if (sku) {
            // Generate idempotency_key from stripe_session_id
            const idempotencyKey = `stripe_${session.id}`;

            console.log(`Applying pack credits: SKU=${sku}, user=${userId}, idempotency_key=${idempotencyKey}`);

            // Apply pack credits using the new function (atomic and idempotent)
            const { data: packResult, error: packError } = await supabaseAdmin.rpc(
              "apply_pack_credits",
              {
                p_user_id: userId,
                p_sku: sku,
                p_idempotency_key: idempotencyKey,
              }
            );

            if (packError || !packResult?.success) {
              console.error("Failed to apply pack credits:", {
                error: packError,
                result: packResult,
              });
              return new Response(
                JSON.stringify({
                  error: "Failed to apply pack credits",
                  details: packError?.message || packResult?.error || "Unknown error",
                }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }

            // Update purchase record with stripe_session_id if it exists
            const { data: existingPurchase } = await supabaseAdmin
              .from("purchases")
              .select("id")
              .eq("idempotency_key", idempotencyKey)
              .single();

            if (!existingPurchase) {
              // Create purchase record if it doesn't exist
              await supabaseAdmin
                .from("purchases")
                .insert({
                  user_id: userId,
                  sku: sku,
                  amount_cents: amountTotal,
                  status: "completed",
                  idempotency_key: idempotencyKey,
                  stripe_session_id: session.id,
                  stripe_customer_id: customerId,
                  metadata: {
                    ...session.metadata,
                    credits: creditsAmount,
                    type: "credits",
                  },
                })
                .catch((err) => console.error("Failed to create purchase record:", err));
            } else {
              // Update existing purchase record with Stripe info
              await supabaseAdmin
                .from("purchases")
                .update({
                  stripe_session_id: session.id,
                  stripe_customer_id: customerId,
                  amount_cents: amountTotal,
                  metadata: {
                    ...session.metadata,
                    credits: creditsAmount,
                    type: "credits",
                  },
                })
                .eq("id", existingPurchase.id)
                .catch((err) => console.error("Failed to update purchase record:", err));
            }

            // Also update stripe_payments table for backward compatibility
            const { data: pendingPayment } = await supabaseAdmin
              .from("stripe_payments")
              .select("id")
              .eq("stripe_session_id", session.id)
              .single();

            if (pendingPayment) {
              await supabaseAdmin
                .from("stripe_payments")
                .update({
                  status: "completed",
                  credits: parseInt(creditsAmount || "0", 10),
                  stripe_customer_id: customerId,
                  metadata: session.metadata || {},
                })
                .eq("id", pendingPayment.id)
                .catch((err) => console.error("Failed to update stripe_payments:", err));
            } else {
              await supabaseAdmin
                .from("stripe_payments")
                .insert({
                  user_id: userId,
                  stripe_session_id: session.id,
                  stripe_customer_id: customerId,
                  amount: amountTotal,
                  currency: currency,
                  type: "credits",
                  credits: parseInt(creditsAmount || "0", 10),
                  status: "completed",
                  metadata: session.metadata || {},
                })
                .catch((err) => console.error("Failed to insert stripe_payments:", err));
            }

            // Track analytics
            await supabaseAdmin
              .from("usage_logs")
              .insert({
                user_id: userId,
                action: "purchase_credits",
                meta: {
                  type: "pack",
                  sku: sku,
                  credits: creditsAmount,
                  amount: amountTotal,
                  pack_purchased: true,
                  pack_applied: true,
                },
              })
              .catch((err) => console.error("Analytics error:", err));

            console.log(`Pack purchase complete: Applied ${sku} pack to user ${userId}`, packResult);
          } else {
            console.warn("No SKU found for checkout session:", {
              session_id: session.id,
              metadata: session.metadata,
              amount_total: amountTotal,
            });
            // Still record the payment even if SKU couldn't be determined
            const { error: insertError } = await supabaseAdmin
              .from("stripe_payments")
              .insert({
                user_id: userId,
                stripe_session_id: session.id,
                stripe_customer_id: customerId,
                amount: amountTotal,
                currency: currency,
                type: "credits",
                credits: 0,
                status: "completed",
                metadata: { ...session.metadata, error: "sku_not_determined" },
              });
            if (insertError) {
              console.error("Failed to record payment without SKU:", insertError);
            }
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
              // Ensure profile exists
              await supabaseAdmin.rpc("ensure_users_profile_exists", {
                p_user_id: sub.user_id,
              });

              // Increment credits using safe method
              const { data: creditResult, error: creditError } = await supabaseAdmin.rpc("safe_increment_credits", {
                p_user_id: sub.user_id,
                p_amount: credits,
              });

              if (creditError || !creditResult?.success) {
                console.error("safe_increment_credits failed for invoice, trying fallback:", {
                  error: creditError,
                  result: creditResult,
                });

                // Fallback to increment_credits
                const { error: fallbackError } = await supabaseAdmin.rpc("increment_credits", {
                  p_user_id: sub.user_id,
                  p_amount: credits,
                });

                if (fallbackError) {
                  console.error("increment_credits fallback also failed:", fallbackError);
                  // Last resort: direct update
                  const { data: profile, error: profileError } = await supabaseAdmin
                    .from("users_profile")
                    .select("credits")
                    .eq("id", sub.user_id)
                    .single();

                  if (!profileError && profile) {
                    await supabaseAdmin
                      .from("users_profile")
                      .update({ credits: (profile.credits || 0) + credits })
                      .eq("id", sub.user_id);
                  }
                }
              } else {
                console.log(`Successfully added ${credits} credits via safe_increment_credits for invoice`, creditResult);
              }

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
