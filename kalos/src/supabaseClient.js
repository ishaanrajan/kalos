import { createClient } from '@supabase/supabase-js'

const supabaseUrl = "https://sxhilxrmifrmdxwgfdxx.supabase.co"
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4aGlseHJtaWZybWR4d2dmZHh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ2ODMwMzcsImV4cCI6MjA2MDI1OTAzN30.StBiuy_ELe07tYpIQeRtdkJRbpsdX7Y8nlLxLyyhGX0"
                    

export const supabase = createClient(supabaseUrl, supabaseKey)