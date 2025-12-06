/**
 * SnapSell - React Native Authentication Examples
 *
 * This file demonstrates how to integrate Supabase Auth with Expo React Native.
 *
 * Prerequisites:
 * - Install: npm install @supabase/supabase-js expo-secure-store
 * - Set up Supabase client with your project URL and publishable key
 *
 * Note: This is an example file. Copy it to your React Native project and install
 * the required dependencies. TypeScript errors about missing modules are expected
 * until you install the packages in your project.
 */

// @ts-ignore - Expo provides process.env at build time
import { createClient } from '@supabase/supabase-js';
// @ts-ignore - Install expo-secure-store in your project
import * as SecureStore from 'expo-secure-store';

// Initialize Supabase client
// Set these in your .env file or app.config.js
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error(
    'Missing Supabase configuration. Please set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in your environment variables.'
  );
}

// Custom storage adapter for Expo SecureStore
const ExpoSecureStoreAdapter = {
  getItem: (key: string) => {
    return SecureStore.getItemAsync(key);
  },
  setItem: (key: string, value: string) => {
    SecureStore.setItemAsync(key, value);
  },
  removeItem: (key: string) => {
    SecureStore.deleteItemAsync(key);
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: ExpoSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// ============================================
// Authentication Functions
// ============================================

/**
 * Sign up with email and password
 */
export async function signUp(email: string, password: string, displayName?: string) {
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: displayName || email.split('@')[0],
        },
      },
    });

    if (error) throw error;

    return { data, error: null };
  } catch (error: any) {
    console.error('Sign up error:', error);
    return { data: null, error };
  }
}

/**
 * Sign in with email and password
 */
export async function signIn(email: string, password: string) {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    return { data, error: null };
  } catch (error: any) {
    console.error('Sign in error:', error);
    return { data: null, error };
  }
}

/**
 * Sign in with magic link (passwordless)
 */
export async function signInWithMagicLink(email: string) {
  try {
    const { data, error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // You can customize the email template here
        emailRedirectTo: 'snapsell://auth/callback',
      },
    });

    if (error) throw error;

    return { data, error: null };
  } catch (error: any) {
    console.error('Magic link error:', error);
    return { data: null, error };
  }
}

/**
 * Sign out current user
 */
export async function signOut() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;

    // Clear any additional stored data if needed
    await SecureStore.deleteItemAsync('supabase_session');

    return { error: null };
  } catch (error: any) {
    console.error('Sign out error:', error);
    return { error };
  }
}

/**
 * Get current authenticated user
 */
export async function getUser() {
  try {
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error) throw error;

    return { user, error: null };
  } catch (error: any) {
    console.error('Get user error:', error);
    return { user: null, error };
  }
}

/**
 * Get current session
 */
export async function getSession() {
  try {
    const { data: { session }, error } = await supabase.auth.getSession();

    if (error) throw error;

    return { session, error: null };
  } catch (error: any) {
    console.error('Get session error:', error);
    return { session: null, error };
  }
}

/**
 * Get user profile from users_profile table
 */
export async function getUserProfile() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return { profile: null, error: { message: 'Not authenticated' } };
    }

    const { data: profile, error } = await supabase
      .from('users_profile')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error) throw error;

    return { profile, error: null };
  } catch (error: any) {
    console.error('Get profile error:', error);
    return { profile: null, error };
  }
}

/**
 * Update user profile
 */
export async function updateUserProfile(updates: {
  display_name?: string;
  avatar_url?: string;
  metadata?: any;
}) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return { profile: null, error: { message: 'Not authenticated' } };
    }

    const { data: profile, error } = await supabase
      .from('users_profile')
      .update(updates)
      .eq('id', user.id)
      .select()
      .single();

    if (error) throw error;

    return { profile, error: null };
  } catch (error: any) {
    console.error('Update profile error:', error);
    return { profile: null, error };
  }
}

/**
 * Listen to auth state changes
 * Useful for updating UI when user signs in/out
 */
export function onAuthStateChange(callback: (user: any) => void) {
  return supabase.auth.onAuthStateChange((event, session) => {
    callback(session?.user || null);
  });
}
