# Payment Integration Guide

This guide covers integrating Ko-fi payments (via Stripe) into your React Native/Expo app.

## Overview

The backend uses Stripe Checkout for all payments, which can be configured to work with Ko-fi. The payment flow is:

1. User initiates purchase in app
2. App calls `create-checkout-session` Edge Function
3. User is redirected to Stripe Checkout
4. After payment, Stripe webhook updates user credits/plan
5. App can verify payment status via `verify-payment` endpoint

## Setup

### 1. Backend Configuration

Follow the main `README.md` section 8 to:
- Create Stripe products (credit packs and subscriptions)
- Configure `STRIPE_PRODUCTS_MAPPING` in Supabase secrets
- Deploy payment Edge Functions

### 2. Frontend Implementation

#### A. Create Payment Utilities

Create `utils/payments.ts`:

```typescript
import { supabase } from './supabase';

const EDGE_FUNCTION_BASE = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL;

interface CheckoutSessionResponse {
  checkout_url: string;
  session_id: string;
}

interface PaymentVerificationResponse {
  payment: {
    id: string;
    status: string;
    type: string;
    credits: number;
    amount: number;
    currency: string;
    created_at: string;
  };
  user: {
    credits: number;
    plan: string;
  };
}

/**
 * Create checkout session for credit purchase
 */
export async function initiateCreditPurchase(
  credits: 10 | 25 | 60
): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(`${EDGE_FUNCTION_BASE}/create-checkout-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      type: 'credits',
      credits: credits,
      user_id: session.user.id,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create checkout session');
  }

  const data: CheckoutSessionResponse = await response.json();
  return data.checkout_url;
}

/**
 * Create checkout session for Pro subscription
 */
export async function initiateProSubscription(
  plan: 'monthly' | 'yearly'
): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(`${EDGE_FUNCTION_BASE}/create-checkout-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      type: 'subscription',
      subscription_plan: plan,
      user_id: session.user.id,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create checkout session');
  }

  const data: CheckoutSessionResponse = await response.json();
  return data.checkout_url;
}

/**
 * Verify payment status by session ID
 */
export async function verifyPaymentStatus(
  sessionId: string
): Promise<PaymentVerificationResponse> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(
    `${EDGE_FUNCTION_BASE}/verify-payment?reference_id=${sessionId}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to verify payment');
  }

  return await response.json();
}
```

#### B. Install Required Dependencies

```bash
npm install expo-linking
# or
yarn add expo-linking
```

#### C. Create Upgrade/Payment Screen

Example upgrade screen component:

```typescript
import React, { useState } from 'react';
import { View, Text, Button, Alert, ActivityIndicator } from 'react-native';
import * as Linking from 'expo-linking';
import { initiateCreditPurchase, initiateProSubscription } from '../utils/payments';
import { useAuth } from '../contexts/AuthContext';

export function UpgradeScreen() {
  const [loading, setLoading] = useState(false);
  const { user, refreshUser } = useAuth();

  const handlePurchaseCredits = async (credits: 10 | 25 | 60) => {
    try {
      setLoading(true);
      const checkoutUrl = await initiateCreditPurchase(credits);

      // Open Stripe checkout in browser
      const canOpen = await Linking.canOpenURL(checkoutUrl);
      if (canOpen) {
        await Linking.openURL(checkoutUrl);
        Alert.alert(
          'Payment Started',
          'Complete your payment in the browser. Your credits will be added automatically.',
          [
            {
              text: 'OK',
              onPress: () => {
                // Optionally poll for payment status or refresh user data
                setTimeout(() => refreshUser(), 5000);
              },
            },
          ]
        );
      } else {
        Alert.alert('Error', 'Cannot open payment URL');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to start payment');
    } finally {
      setLoading(false);
    }
  };

  const handleSubscribe = async (plan: 'monthly' | 'yearly') => {
    try {
      setLoading(true);
      const checkoutUrl = await initiateProSubscription(plan);

      const canOpen = await Linking.canOpenURL(checkoutUrl);
      if (canOpen) {
        await Linking.openURL(checkoutUrl);
        Alert.alert(
          'Subscription Started',
          'Complete your subscription in the browser. Your plan will be upgraded automatically.',
          [
            {
              text: 'OK',
              onPress: () => {
                setTimeout(() => refreshUser(), 5000);
              },
            },
          ]
        );
      } else {
        Alert.alert('Error', 'Cannot open payment URL');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to start subscription');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ padding: 20 }}>
      <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 20 }}>
        Upgrade Your Account
      </Text>

      <Text style={{ fontSize: 18, marginBottom: 10 }}>Credit Packs</Text>
      <Button
        title="Buy 10 Credits - $5"
        onPress={() => handlePurchaseCredits(10)}
        disabled={loading}
      />
      <Button
        title="Buy 25 Credits - $10"
        onPress={() => handlePurchaseCredits(25)}
        disabled={loading}
      />
      <Button
        title="Buy 60 Credits - $20"
        onPress={() => handlePurchaseCredits(60)}
        disabled={loading}
      />

      <Text style={{ fontSize: 18, marginTop: 20, marginBottom: 10 }}>
        Pro Subscription
      </Text>
      <Button
        title="Subscribe Monthly - $9.99/month"
        onPress={() => handleSubscribe('monthly')}
        disabled={loading}
      />
      <Button
        title="Subscribe Yearly - $99.99/year"
        onPress={() => handleSubscribe('yearly')}
        disabled={loading}
      />

      {loading && <ActivityIndicator style={{ marginTop: 20 }} />}

      <Text style={{ marginTop: 20, fontSize: 12, color: 'gray' }}>
        Current Credits: {user?.credits || 0}
      </Text>
      <Text style={{ fontSize: 12, color: 'gray' }}>
        Current Plan: {user?.plan || 'free'}
      </Text>
    </View>
  );
}
```

#### D. Handle Payment Success Callback (Optional)

If you want to handle the redirect after payment:

```typescript
import { useEffect } from 'react';
import * as Linking from 'expo-linking';
import { verifyPaymentStatus } from '../utils/payments';

// In your app's root component or payment screen
useEffect(() => {
  const handleDeepLink = async (event: { url: string }) => {
    const { url } = event;

    // Check if it's a payment success callback
    if (url.includes('/payment/success')) {
      const urlObj = new URL(url);
      const sessionId = urlObj.searchParams.get('session_id');

      if (sessionId) {
        try {
          const result = await verifyPaymentStatus(sessionId);
          Alert.alert(
            'Payment Successful',
            `You now have ${result.user.credits} credits!`
          );
          // Refresh user data
          await refreshUser();
        } catch (error) {
          Alert.alert('Error', 'Failed to verify payment');
        }
      }
    }
  };

  // Listen for deep links
  Linking.addEventListener('url', handleDeepLink);

  // Check if app was opened via deep link
  Linking.getInitialURL().then((url) => {
    if (url) {
      handleDeepLink({ url });
    }
  });

  return () => {
    Linking.removeEventListener('url', handleDeepLink);
  };
}, []);
```

## Payment Flow

1. **User clicks "Buy Credits" or "Subscribe"**
   - App calls `initiateCreditPurchase()` or `initiateProSubscription()`
   - Edge Function creates Stripe checkout session
   - Returns checkout URL

2. **User completes payment**
   - App opens Stripe Checkout in browser
   - User enters payment details and completes purchase
   - Stripe redirects to success URL

3. **Backend processes payment**
   - Stripe sends webhook to `stripe-webhook` function
   - Webhook updates user credits or plan
   - Payment is recorded in `stripe_payments` table

4. **App verifies payment (optional)**
   - App can poll `verify-payment` endpoint
   - Or wait for webhook to process and refresh user data

## Testing

1. Use Stripe test mode for development
2. Test credit purchases with test card: `4242 4242 4242 4242`
3. Verify credits are added to user account
4. Test subscription creation and cancellation
5. Verify webhook events in Stripe Dashboard

## Troubleshooting

**Payment not processing:**
- Check Stripe webhook is configured correctly
- Verify `STRIPE_PRODUCTS_MAPPING` is set in Supabase secrets
- Check Edge Function logs in Supabase Dashboard

**Credits not added:**
- Verify webhook received `checkout.session.completed` event
- Check `stripe_payments` table for payment record
- Verify user_id matches in checkout session metadata

**Checkout URL not opening:**
- Ensure `expo-linking` is installed
- Check URL format is valid
- Test with `Linking.canOpenURL()` first

## Security Notes

- Always verify user authentication before creating checkout sessions
- Never expose Stripe secret keys in frontend code
- Use HTTPS for all payment-related endpoints
- Validate payment status server-side before granting access
