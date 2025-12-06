# React Native Integration Examples

This directory contains example code for integrating SnapSell backend with your Expo React Native app.

## Quick Start

**📖 For detailed setup instructions, see [SETUP.md](./SETUP.md)**

1. **Install required dependencies:**

```bash
npm install @supabase/supabase-js expo-secure-store expo-file-system expo-image-picker
```

2. **Set up environment variables:**

Create a `.env` file in your project root:

```env
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL=https://your-project.supabase.co/functions/v1
```

**Note:** `EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL` is optional - it will default to `${EXPO_PUBLIC_SUPABASE_URL}/functions/v1` if not set.

3. **Copy the example files to your React Native project:**

```bash
# Copy to your utils or lib directory
cp examples/react-native/auth.ts src/utils/
cp examples/react-native/listings.ts src/utils/
```

4. **Import and use:**

```typescript
import { signIn, getUser } from './utils/auth';
import { createListingFromImage, checkQuota } from './utils/listings';
```

## Usage Examples

### Authentication

```typescript
import { signUp, signIn, signInWithMagicLink, signOut, getUser } from './auth';

// Sign up
const { data, error } = await signUp('user@example.com', 'password123', 'John Doe');

// Sign in with password
const { data, error } = await signIn('user@example.com', 'password123');

// Sign in with magic link (passwordless)
const { data, error } = await signInWithMagicLink('user@example.com');
// User will receive an email with a magic link

// Get current user
const { user, error } = await getUser();

// Sign out
await signOut();
```

### Create Listing Flow

```typescript
import {
  pickImage,
  createListingFromImage,
  checkQuota
} from './listings';

// Check quota before creating
const { quota } = await checkQuota();
console.log(`Used: ${quota.used}/${quota.limit}, Remaining: ${quota.remaining}`);

// Pick image from device
const imageBase64 = await pickImage();

if (imageBase64) {
  // Create listing (upload → generate → save)
  const { listing, error } = await createListingFromImage(
    imageBase64,
    'shared' // visibility: 'private' | 'shared' | 'public'
  );

  if (listing) {
    console.log('Listing created:', listing.id);
    console.log('Share URL:', `https://yourapp.com/share/${listing.share_slug}`);
  } else if (error?.code === 'QUOTA_EXCEEDED') {
    // Handle quota exceeded - show upgrade prompt
    console.log('Quota exceeded. Please upgrade or purchase credits.');
  }
}
```

### Share Listing

```typescript
import { getListingBySlug } from './listings';

// Get shared listing (no auth required)
const { listing, error } = await getListingBySlug('abc123xyz');

if (listing) {
  console.log('Title:', listing.title);
  console.log('Image URL:', listing.image_url);
}
```

### Submit Feedback

```typescript
import { submitFeedback } from './listings';

// App feedback
await submitFeedback({
  type: 'app',
  rating: 5,
  comment: 'Great app!',
});

// Listing feedback
await submitFeedback({
  type: 'listing',
  listing_id: 'listing-uuid',
  rating: 4,
  comment: 'Nice item!',
});
```

## Error Handling

All functions return `{ data, error }` or `{ listing, error }` format. Always check for errors:

```typescript
const { listing, error } = await createListing(params);

if (error) {
  if (error.code === 'QUOTA_EXCEEDED') {
    // Handle quota exceeded
  } else {
    // Handle other errors
    console.error('Error:', error.message);
  }
} else {
  // Success
  console.log('Listing created:', listing);
}
```

## Authentication State

Listen to auth state changes to update UI:

```typescript
import { onAuthStateChange } from './auth';

const subscription = onAuthStateChange((user) => {
  if (user) {
    console.log('User signed in:', user.email);
  } else {
    console.log('User signed out');
  }
});

// Unsubscribe when component unmounts
// subscription.data.subscription.unsubscribe();
```

## Migrating Local Listings to Backend

If you have local listings stored in AsyncStorage or local state, use the migration helper:

```typescript
import { migrateLocalListingsToBackend } from './listings';

// Your local listings structure
const localListings = [
  {
    id: 'local-1',
    title: 'Vintage Chair',
    description: 'Beautiful vintage chair',
    price_cents: 7500,
    imageBase64: 'data:image/jpeg;base64,...', // or imageUri: 'file://...'
    // ... other fields
  },
  // ... more listings
];

// Migrate with progress tracking
const result = await migrateLocalListingsToBackend(
  localListings,
  (progress) => {
    console.log(`Migrating ${progress.current}/${progress.total}: ${progress.listingId}`);
  }
);

console.log(`Migration complete: ${result.migrated} migrated, ${result.failed} failed`);
if (result.errors.length > 0) {
  console.error('Errors:', result.errors);
}
```

The migration function will:
1. Upload images to Supabase Storage (if not already uploaded)
2. Create listings on the backend
3. Handle quota checks automatically
4. Return detailed results with any errors

## Type Definitions

All functions return consistent error formats:

```typescript
// Success
{ listing: {...}, error: null }
{ data: {...}, error: null }

// Error
{ listing: null, error: { message: string, code?: string, details?: string } }
{ data: null, error: Error }
```

## Error Codes

- `QUOTA_EXCEEDED` - User has reached their listing limit
- `UNAUTHORIZED` - User is not authenticated
- `VALIDATION_ERROR` - Invalid request data
- `INTERNAL_ERROR` - Server error

## Notes

- All Edge Functions require authentication except `listings-get-by-slug` (public share links)
- Image uploads are limited to 10MB
- Free tier allows 10 listings per 30-day rolling window (configurable)
- Quota checks happen automatically when creating listings
- Share slugs are generated automatically for listings with visibility 'shared' or 'public'
- `description` and `price_cents` are optional fields (useful for migrations)
