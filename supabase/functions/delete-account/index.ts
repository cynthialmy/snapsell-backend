import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use built-in Supabase environment variables (automatically available in Edge Functions)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
      console.error("Missing Supabase environment variables:", {
        hasUrl: !!supabaseUrl,
        hasServiceRoleKey: !!supabaseServiceRoleKey,
        hasAnonKey: !!supabaseAnonKey,
      });
      return new Response(
        JSON.stringify({
          error: "Server configuration error",
          details: "Supabase environment variables are not available. This should not happen in Edge Functions.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with service role key for admin operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Create client with anon key for user authentication validation
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    // Get authenticated user
    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = user.id;

    // Step 1: Delete all storage files from items/{user_id}/*
    try {
      const userFolderPath = `${userId}/`;

      // List all files in the user's folder
      const { data: files, error: listError } = await supabaseAdmin.storage
        .from("items")
        .list(userFolderPath, {
          limit: 1000,
          offset: 0,
          sortBy: { column: "name", order: "asc" },
        });

      if (listError && listError.message !== "The resource was not found") {
        console.error("Error listing storage files:", listError);
        // Continue with deletion even if listing fails - files might not exist
      } else if (files && files.length > 0) {
        // Delete all files in the user's folder
        const filePaths = files
          .filter((file) => file.name) // Filter out folders
          .map((file) => `${userFolderPath}${file.name}`);

        if (filePaths.length > 0) {
          const { error: deleteError } = await supabaseAdmin.storage
            .from("items")
            .remove(filePaths);

          if (deleteError) {
            console.error("Error deleting storage files:", deleteError);
            // Continue with account deletion even if storage deletion fails
            // The files will be orphaned but the account will still be deleted
          } else {
            console.log(`Deleted ${filePaths.length} storage file(s) for user ${userId}`);
          }
        }
      }
    } catch (storageError) {
      console.error("Storage deletion error:", storageError);
      // Continue with account deletion even if storage deletion fails
    }

    // Step 2: Delete auth user (this will cascade delete database records)
    // Database tables with ON DELETE CASCADE:
    // - listings (user_id references auth.users)
    // - users_profile (id references auth.users)
    // - subscriptions (user_id references auth.users)
    // Other tables use ON DELETE SET NULL, so they'll be cleaned up automatically
    const { data: deleteData, error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(
      userId
    );

    if (deleteError) {
      console.error("Error deleting user:", deleteError);
      return new Response(
        JSON.stringify({
          error: "Failed to delete account",
          details: deleteError.message,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Account deleted successfully",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unhandled error:", error);
    console.error("Error stack:", error instanceof Error ? error.stack : "No stack trace");
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
        type: error instanceof Error ? error.constructor.name : typeof error,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
