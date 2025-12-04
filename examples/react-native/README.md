# React Native Integration Examples

This directory contains example code for integrating SnapSell backend with your Expo React Native app.

## Setup

1. Install required dependencies:

```bash
npm install @supabase/supabase-js expo-secure-store expo-file-system expo-image-picker
```

2. Set up environment variables in your `.env` file:

```
EXPO_PUBLIC_SUPABASE_URL=your_supabase_project_url
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL=your_supabase_functions_url
```

3. Copy the example files to your React Native project and import as needed.

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

## Notes

- All Edge Functions require authentication except `listings-get-by-slug` (public share links)
- Image uploads are limited to 10MB
- Free tier allows 10 listings per 30-day rolling window (configurable)
- Quota checks happen automatically when creating listings
- Share slugs are generated automatically for listings with visibility 'shared' or 'public'
