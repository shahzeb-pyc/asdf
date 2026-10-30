import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from './config.js';

if (!SUPABASE_CONFIG.URL || !SUPABASE_CONFIG.SERVICE_ROLE_KEY) {
  console.error("❌ Supabase URL and Service Role Key are required.");
  process.exit(1);
}

export const supabase = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.SERVICE_ROLE_KEY);