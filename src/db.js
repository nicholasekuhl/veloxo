const { createClient } = require('@supabase/supabase-js')

// TODO: Switch SUPABASE_URL in Railway env vars
// from port 5432 to port 6543 (pooled connection)
// Settings > Database > Connection Pooling in
// Supabase dashboard
const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env')
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
})

module.exports = supabase
