// Supabase Edge Function: welcome-email
//
// Triggered by a Database Webhook on insert into public.profiles -- which is
// exactly signup, since handle_new_user() (0003_counters.sql) is what
// creates that row. Sends the welcome email through Resend.
//
// Deploy via Dashboard -> Edge Functions -> New Function (paste this file),
// name it exactly `welcome-email`. Needs one secret set first: Dashboard ->
// Edge Functions -> Manage secrets -> RESEND_API_KEY. Turn off "Enforce JWT
// verification" the same way as the notify function.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const resendApiKey = Deno.env.get('RESEND_API_KEY');
const db = createClient(supabaseUrl, serviceRoleKey);

interface WebhookPayload {
  type: 'INSERT';
  table: 'profiles';
  record: { id: string; username: string; display_name: string | null };
}

/** Prefer a set display_name (first word only, e.g. "Diya Rao" -> "Diya"); fall back to the username as-is. */
function greetingName(username: string, displayName: string | null): string {
  const raw = displayName?.trim() ? displayName.trim().split(/\s+/)[0] : username;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function emailBody(name: string): string {
  return `Hey ${name} — you're in.

Kalos is basically Instagram circa 2015: your friends, chronological feed, no algo, no reels, no randos. That's it.

Two things:
1. Post a bit — the app gets better the more real photos are in it.
2. See the message icon on your feed? That's a direct line to me. Bug, idea, complaint, whatever — DM it over, I read and respond to everything.

Have fun with it.

Yours truly,
Ishaan`;
}

Deno.serve(async (req) => {
  if (!resendApiKey) {
    console.error('RESEND_API_KEY is not set');
    return new Response('not configured', { status: 200 });
  }

  const payload = (await req.json()) as WebhookPayload;
  const { id, username, display_name } = payload.record;

  const { data: user, error } = await db.auth.admin.getUserById(id);
  if (error || !user?.user?.email) {
    console.error('could not resolve email', error);
    return new Response('no email', { status: 200 });
  }
  const email = user.user.email;

  // Seed fixtures (scripts/seed.ts) use @example.com and would otherwise get
  // a "welcome" email every time the seed script re-runs.
  if (email.endsWith('@example.com')) {
    return new Response('skipped seed fixture', { status: 200 });
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Kalos <onboarding@resend.dev>',
      to: [email],
      subject: 'Welcome to Kalos',
      text: emailBody(greetingName(username, display_name)),
    }),
  });

  return new Response(await res.text(), { status: res.ok ? 200 : 502 });
});
