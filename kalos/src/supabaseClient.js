import { createClient } from '@supabase/supabase-js'

const supabaseUrl = "https://sxhilxrmifrmdxwgfdxx.supabase.co"
const supabaseKey = "dOaTXrq//YvnNICGUmszY7G3D++cMGrWss5H0hlhhx2Gyz0UI9wgJV9vuthLl35h+DeG/9abBytp0t7R9iyqyg=="

export const supabase = createClient(supabaseUrl, supabaseKey)