-- Storage Policies for Supabase Storage
-- These policies control access to the 'items' bucket

-- Create the items bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'items',
  'items',
  false,
  10485760, -- 10MB
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- STORAGE POLICIES: Upload
-- ============================================

-- Users can upload files to their own folder
CREATE POLICY "Users can upload to own folder"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'items' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================
-- STORAGE POLICIES: Read
-- ============================================

-- Users can read their own files
CREATE POLICY "Users can read own files"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'items' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Public read for shared listings (via Edge Function with signed URLs)
-- Note: Direct public access is not enabled for security.
-- Edge Functions will generate signed URLs for shared listings.

-- ============================================
-- STORAGE POLICIES: Update
-- ============================================

-- Users can update their own files
CREATE POLICY "Users can update own files"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'items' AND
  (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'items' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================
-- STORAGE POLICIES: Delete
-- ============================================

-- Users can delete their own files
CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'items' AND
  (storage.foldername(name))[1] = auth.uid()::text
);
