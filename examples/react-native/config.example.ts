/**
 * Configuration Example
 *
 * Copy this file to config.ts and fill in your values,
 * or use environment variables in your app.config.js / .env
 *
 * Note: In Expo, process.env is available at build time through app.config.js
 */

// @ts-ignore - Expo provides process.env at build time
export const config = {
    supabase: {
        url: process.env.EXPO_PUBLIC_SUPABASE_URL || 'YOUR_SUPABASE_URL',
        anonKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'YOUR_SUPABASE_PUBLISHABLE_KEY',
        functionsUrl: process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL ||
            (process.env.EXPO_PUBLIC_SUPABASE_URL
                ? `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1`
                : null),
    },
    app: {
        // Your app's deep link scheme (for email confirmation and magic link redirects)
        // This should match EXPO_PUBLIC_DEEP_LINK_SCHEME in your .env file
        deepLinkScheme: process.env.EXPO_PUBLIC_DEEP_LINK_SCHEME || 'snapsell',
        // Your app's share URL base (for generating share links)
        shareUrlBase: 'https://yourapp.com/share',
    },
};

// Validate configuration
if (!config.supabase.url || !config.supabase.anonKey) {
    console.warn(
        '⚠️ Missing Supabase configuration. Please set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'
    );
}
