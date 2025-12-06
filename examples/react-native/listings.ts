/**
 * SnapSell - React Native Listings Examples
 *
 * This file demonstrates how to interact with listings, upload images,
 * generate AI content, and share listings using Supabase Edge Functions.
 *
 * Prerequisites:
 * - Supabase client initialized (see auth.ts)
 * - Edge Functions deployed to your Supabase project
 *
 * Note: This is an example file. Copy it to your React Native project and install
 * the required dependencies. TypeScript errors about missing modules are expected
 * until you install the packages in your project.
 */

import { supabase } from './auth';
// @ts-ignore - Install expo-file-system in your project
import * as FileSystem from 'expo-file-system';
// @ts-ignore - Install expo-image-picker in your project
import * as ImagePicker from 'expo-image-picker';

// Edge Function base URL
// If EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL is not set, it will default to the standard Supabase functions URL
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const EDGE_FUNCTION_BASE = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : null);

if (!EDGE_FUNCTION_BASE) {
  throw new Error(
    'Missing Supabase configuration. Please set EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL in your environment variables.'
  );
}

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
      const errorData = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(errorData.error || `Upload failed with status ${response.status}`);
    }

    const data = await response.json();
    return { data, error: null };
  } catch (error: any) {
    console.error('Upload error:', error);
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
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
  description?: string; // Optional for migration compatibility
  price_cents?: number; // Optional for migration compatibility
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

      // Return detailed error information
      const errorMessage = data.error || 'Failed to create listing';
      const errorDetails = data.details || data.message || '';

      return {
        listing: null,
        error: {
          message: errorMessage,
          details: errorDetails,
          code: data.code,
          ...data,
        },
      };
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
      description: genData.description || undefined,
      price_cents: genData.price_cents || undefined,
      currency: genData.currency || 'USD',
      condition: genData.condition || undefined,
      category: genData.category || undefined,
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

// ============================================
// Migration Helpers
// ============================================

/**
 * Local listing structure (from AsyncStorage or local state)
 */
interface LocalListing {
  id: string;
  title: string;
  description?: string;
  price_cents?: number;
  currency?: string;
  condition?: string;
  category?: string;
  tags?: string[];
  imageUri?: string; // Local file URI
  imageBase64?: string; // Base64 encoded image
  storage_path?: string; // Already uploaded storage path
  thumbnail_path?: string;
  ai_generated?: any;
  visibility?: 'private' | 'shared' | 'public';
  created_at?: string;
}

/**
 * Migrate local listings to backend
 * Uploads images if needed, then creates listings on backend
 */
export async function migrateLocalListingsToBackend(
  localListings: LocalListing[],
  onProgress?: (progress: { current: number; total: number; listingId: string }) => void
): Promise<{
  migrated: number;
  failed: number;
  errors: Array<{ listingId: string; error: any }>;
}> {
  const results = {
    migrated: 0,
    failed: 0,
    errors: [] as Array<{ listingId: string; error: any }>,
  };

  for (let i = 0; i < localListings.length; i++) {
    const localListing = localListings[i];

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: localListings.length,
        listingId: localListing.id,
      });
    }

    try {
      let storagePath = localListing.storage_path;
      let thumbnailPath = localListing.thumbnail_path;

      // If no storage_path, upload image first
      if (!storagePath && (localListing.imageBase64 || localListing.imageUri)) {
        let imageBase64 = localListing.imageBase64;

        // If we have a local URI, read it as base64
        if (!imageBase64 && localListing.imageUri) {
          try {
            // For React Native, use expo-file-system to read local files
            // This requires expo-file-system to be installed
            // @ts-ignore - FileSystem is available when expo-file-system is installed
            const fileInfo = await FileSystem.getInfoAsync(localListing.imageUri);
            if (fileInfo.exists) {
              // @ts-ignore - expo-file-system uses string encoding, not enum
              const base64 = await FileSystem.readAsStringAsync(
                localListing.imageUri,
                { encoding: 'base64' }
              );
              imageBase64 = `data:image/jpeg;base64,${base64}`;
            }
          } catch (readError) {
            console.error(`Failed to read image for listing ${localListing.id}:`, readError);
            results.failed++;
            results.errors.push({
              listingId: localListing.id,
              error: new Error(`Failed to read image: ${readError}`),
            });
            continue;
          }
        }

        if (imageBase64) {
          // Upload image
          const { data: uploadData, error: uploadError } = await uploadImage(imageBase64);
          if (uploadError || !uploadData) {
            throw new Error(`Upload failed: ${uploadError?.message || 'Unknown error'}`);
          }
          storagePath = uploadData.storage_path;
        }
      }

      if (!storagePath) {
        throw new Error('No image available to upload');
      }

      // Create listing on backend
      const { listing, error: createError } = await createListing({
        title: localListing.title,
        description: localListing.description,
        price_cents: localListing.price_cents,
        currency: localListing.currency || 'USD',
        condition: localListing.condition,
        category: localListing.category,
        tags: localListing.tags || [],
        storage_path: storagePath,
        thumbnail_path: thumbnailPath,
        ai_generated: localListing.ai_generated,
        visibility: localListing.visibility || 'private',
      });

      if (createError) {
        throw createError;
      }

      results.migrated++;
    } catch (error: any) {
      console.error(`Error migrating listing: ${localListing.id}`, error);
      results.failed++;
      results.errors.push({
        listingId: localListing.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return results;
}
