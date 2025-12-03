/**
 * SnapSell - React Native Listings Examples
 *
 * This file demonstrates how to interact with listings, upload images,
 * generate AI content, and share listings using Supabase Edge Functions.
 *
 * Prerequisites:
 * - Supabase client initialized (see auth.ts)
 * - Edge Functions deployed to your Supabase project
 */

import { supabase } from './auth';
import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

// Edge Function base URL
const EDGE_FUNCTION_BASE = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL ||
  `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1`;

// ============================================
// Image Upload
// ============================================

/**
 * Pick an image from device and convert to base64
 */
export async function pickImage(): Promise<string | null> {
  try {
    // Request permissions
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('Permission to access media library denied');
    }

    // Pick image
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
      base64: true,
    });

    if (result.canceled || !result.assets[0]) {
      return null;
    }

    const asset = result.assets[0];
    const base64 = `data:image/jpeg;base64,${asset.base64}`;
    return base64;
  } catch (error) {
    console.error('Image pick error:', error);
    return null;
  }
}

/**
 * Upload image to Supabase Storage via Edge Function
 */
export async function uploadImage(base64Image: string, contentType: string = 'image/jpeg') {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${EDGE_FUNCTION_BASE}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        file: base64Image,
        contentType,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Upload failed');
    }

    const data = await response.json();
    return { data, error: null };
  } catch (error: any) {
    console.error('Upload error:', error);
    return { data: null, error };
  }
}

// ============================================
// AI Generation
// ============================================

/**
 * Generate listing content from uploaded image
 */
export async function generateListingContent(storagePath: string) {
  try {
    const { data: { session } } = await supabase.auth.getSession();

    const response = await fetch(`${EDGE_FUNCTION_BASE}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session && { 'Authorization': `Bearer ${session.access_token}` }),
      },
      body: JSON.stringify({
        storage_path: storagePath,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Generation failed');
    }

    const data = await response.json();
    return { data, error: null };
  } catch (error: any) {
    console.error('Generation error:', error);
    return { data: null, error };
  }
}

// ============================================
// Listing Management
// ============================================

interface CreateListingParams {
  title: string;
  description: string;
  price_cents: number;
  currency?: string;
  condition?: string;
  category?: string;
  tags?: string[];
  storage_path: string;
  thumbnail_path?: string;
  ai_generated?: any;
  visibility?: 'private' | 'shared' | 'public';
}

/**
 * Create a new listing (with quota enforcement)
 */
export async function createListing(params: CreateListingParams) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${EDGE_FUNCTION_BASE}/listings-create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(params),
    });

    const data = await response.json();

    if (!response.ok) {
      // Handle quota exceeded (402)
      if (response.status === 402) {
        return {
          listing: null,
          error: {
            code: 'QUOTA_EXCEEDED',
            message: data.message || 'Quota exceeded',
            ...data,
          },
        };
      }
      throw new Error(data.error || 'Failed to create listing');
    }

    return { listing: data.listing, quota: data.quota, error: null };
  } catch (error: any) {
    console.error('Create listing error:', error);
    return { listing: null, error };
  }
}

/**
 * Get listing by share slug (public, no auth required)
 */
export async function getListingBySlug(slug: string) {
  try {
    const response = await fetch(`${EDGE_FUNCTION_BASE}/listings-get-by-slug/${slug}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Listing not found');
    }

    const data = await response.json();
    return { listing: data, error: null };
  } catch (error: any) {
    console.error('Get listing error:', error);
    return { listing: null, error };
  }
}

/**
 * Get user's listings
 */
export async function getMyListings() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw new Error('Not authenticated');
    }

    const { data: listings, error } = await supabase
      .from('listings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return { listings, error: null };
  } catch (error: any) {
    console.error('Get listings error:', error);
    return { listings: null, error };
  }
}

/**
 * Update a listing
 */
export async function updateListing(listingId: string, updates: Partial<CreateListingParams>) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw new Error('Not authenticated');
    }

    const { data: listing, error } = await supabase
      .from('listings')
      .update(updates)
      .eq('id', listingId)
      .select()
      .single();

    if (error) throw error;

    return { listing, error: null };
  } catch (error: any) {
    console.error('Update listing error:', error);
    return { listing: null, error };
  }
}

/**
 * Delete a listing
 */
export async function deleteListing(listingId: string) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw new Error('Not authenticated');
    }

    const { error } = await supabase
      .from('listings')
      .delete()
      .eq('id', listingId);

    if (error) throw error;

    return { error: null };
  } catch (error: any) {
    console.error('Delete listing error:', error);
    return { error };
  }
}

// ============================================
// Full Flow: Upload → Generate → Create
// ============================================

/**
 * Complete flow: Pick image, upload, generate, and create listing
 */
export async function createListingFromImage(
  imageBase64: string,
  visibility: 'private' | 'shared' | 'public' = 'shared'
) {
  try {
    // Step 1: Upload image
    const { data: uploadData, error: uploadError } = await uploadImage(imageBase64);
    if (uploadError || !uploadData) {
      throw new Error('Failed to upload image');
    }

    // Step 2: Generate listing content
    const { data: genData, error: genError } = await generateListingContent(uploadData.storage_path);
    if (genError || !genData) {
      throw new Error('Failed to generate content');
    }

    // Step 3: Create listing
    const { listing, error: createError } = await createListing({
      title: genData.title,
      description: genData.description,
      price_cents: genData.price_cents,
      currency: genData.currency || 'USD',
      condition: genData.condition,
      category: genData.category,
      tags: genData.tags || [],
      storage_path: uploadData.storage_path,
      ai_generated: genData.ai_generated,
      visibility,
    });

    if (createError) {
      throw createError;
    }

    return { listing, error: null };
  } catch (error: any) {
    console.error('Create listing from image error:', error);
    return { listing: null, error };
  }
}

// ============================================
// Usage & Quota
// ============================================

/**
 * Check current usage and quota
 */
export async function checkQuota() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${EDGE_FUNCTION_BASE}/usage-check-quota`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to check quota');
    }

    const data = await response.json();
    return { quota: data, error: null };
  } catch (error: any) {
    console.error('Check quota error:', error);
    return { quota: null, error };
  }
}

// ============================================
// Feedback
// ============================================

/**
 * Submit feedback
 */
export async function submitFeedback(params: {
  type: 'app' | 'listing';
  listing_id?: string;
  rating?: number;
  comment: string;
  attachment?: string;
  attachment_filename?: string;
}) {
  try {
    const { data: { session } } = await supabase.auth.getSession();

    const response = await fetch(`${EDGE_FUNCTION_BASE}/feedback-create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session && { 'Authorization': `Bearer ${session.access_token}` }),
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to submit feedback');
    }

    const data = await response.json();
    return { feedback: data.feedback, error: null };
  } catch (error: any) {
    console.error('Submit feedback error:', error);
    return { feedback: null, error };
  }
}
