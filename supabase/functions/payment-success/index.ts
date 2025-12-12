import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Simple redirect handler for payment success
// This can redirect to your app's deep link or show a success message
serve(async (req) => {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");

  // If session_id is provided, you could verify payment status here
  // For now, just show a simple success message or redirect

  // Option 1: Show HTML success page
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Payment Successful</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        .container {
          text-align: center;
          padding: 2rem;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 1rem;
          backdrop-filter: blur(10px);
          max-width: 400px;
        }
        h1 { margin-top: 0; }
        .message {
          margin: 1rem 0;
          opacity: 0.9;
        }
        .button {
          display: inline-block;
          margin-top: 1rem;
          padding: 0.75rem 1.5rem;
          background: white;
          color: #667eea;
          text-decoration: none;
          border-radius: 0.5rem;
          font-weight: 600;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>✅ Payment Successful!</h1>
        <p class="message">Your payment has been processed successfully.</p>
        <p class="message">Your credits have been added to your account.</p>
        <p class="message">You can close this window and return to the app.</p>
        ${sessionId ? `<p style="font-size: 0.8rem; opacity: 0.7;">Session: ${sessionId.substring(0, 20)}...</p>` : ''}
      </div>
    </body>
    </html>
  `;

  return new Response(html, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html",
    },
  });
});

