-- ============================================
-- TABLE: Stripe Payments Tracking
-- ============================================
-- Tracks all Stripe payments (including Ko-fi via Stripe)
-- for credit purchases and subscriptions
CREATE TABLE public.stripe_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_session_id text UNIQUE,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  amount integer NOT NULL, -- Amount in cents
  currency text DEFAULT 'usd',
  type text NOT NULL CHECK (type IN ('credits', 'subscription')),
  credits integer DEFAULT 0, -- Number of credits purchased (if type is 'credits')
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX idx_stripe_payments_user_id ON public.stripe_payments (user_id);
CREATE INDEX idx_stripe_payments_session_id ON public.stripe_payments (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX idx_stripe_payments_status ON public.stripe_payments (status);
CREATE INDEX idx_stripe_payments_created_at ON public.stripe_payments (created_at);

-- ============================================
-- FUNCTION: Update updated_at on stripe_payments
-- ============================================
CREATE TRIGGER update_stripe_payments_updated_at
  BEFORE UPDATE ON public.stripe_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- RLS Policies for stripe_payments
-- ============================================
-- Users can only view their own payment records
ALTER TABLE public.stripe_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own payments"
  ON public.stripe_payments
  FOR SELECT
  USING (auth.uid() = user_id);

-- Only service role can insert/update (via Edge Functions)
CREATE POLICY "Service role can manage payments"
  ON public.stripe_payments
  FOR ALL
  USING (false); -- Edge Functions use service role, bypassing RLS
