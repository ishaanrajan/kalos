// Supabase Edge Function: welcome-email
//
// Triggered by a Database Webhook on insert into public.profiles -- which is
// exactly signup, since handle_new_user() (0003_counters.sql) is what
// creates that row. Sends the welcome email over real Gmail SMTP -- Google's
// own servers, authenticated as a real Google account via an app password,
// so there's no third-party-sender/domain-verification problem at all.
//
// Deploy via Dashboard -> Edge Functions -> New Function (paste this file),
// name it exactly `welcome-email`. Needs two secrets set first: Dashboard ->
// Edge Functions -> Manage secrets:
//   GMAIL_USER            the sending Gmail address, e.g. you@gmail.com
//   GMAIL_APP_PASSWORD    an app-specific password (Google Account ->
//                         Security -> 2-Step Verification -> App passwords)
// Turn off "Enforce JWT verification" the same way as the notify function.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const gmailUser = Deno.env.get('GMAIL_USER');
const gmailAppPassword = Deno.env.get('GMAIL_APP_PASSWORD');
const db = createClient(supabaseUrl, serviceRoleKey);

interface WebhookPayload {
  type: 'INSERT';
  table: 'profiles';
  record: { id: string; username: string; display_name: string | null };
}

/** Prefer a set display_name (first word only, e.g. "Diya Rao" -> "Diya"); fall back to the username as-is. */
function greetingName(username: string, displayName: string | null): string {
  let raw = username;
  const trimmed = displayName ? displayName.trim() : '';
  if (trimmed.length > 0) {
    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex === -1) {
      raw = trimmed;
    } else {
      raw = trimmed.substring(0, spaceIndex);
    }
  }
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
  if (!gmailUser || !gmailAppPassword) {
    console.error('GMAIL_USER / GMAIL_APP_PASSWORD is not set');
    return new Response('not configured', { status: 200 });
  }

  const payload = (await req.json()) as WebhookPayload;
  const { id, username, display_name } = payload.record;

  // Idempotency guard: protects against a webhook re-fire, a manual re-run,
  // or this same function being invoked twice for the same signup.
  const { data: profile } = await db.from('profiles').select('welcome_emailed_at').eq('id', id).single();
  if (profile?.welcome_emailed_at) {
    return new Response('already sent', { status: 200 });
  }

  const { data: userResult, error } = await db.auth.admin.getUserById(id);
  const email = userResult && userResult.user ? userResult.user.email : null;
  if (error || !email) {
    console.error('could not resolve email', error);
    return new Response('no email', { status: 200 });
  }

  // Seed fixtures (scripts/seed.ts) use @example.com and would otherwise get
  // a "welcome" email every time the seed script re-runs.
  if (email.endsWith('@example.com')) {
    return new Response('skipped seed fixture', { status: 200 });
  }

  const client = new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true,
      auth: { username: gmailUser, password: gmailAppPassword },
    },
  });

  try {
    await client.send({
      from: `Kalos <${gmailUser}>`,
      to: email,
      subject: 'Welcome to Kalos',
      content: emailBody(greetingName(username, display_name)),
    });
    await db.from('profiles').update({ welcome_emailed_at: new Date().toISOString() }).eq('id', id);
    return new Response('sent', { status: 200 });
  } catch (e) {
    console.error('SMTP send failed', e);
    return new Response('send failed', { status: 502 });
  } finally {
    await client.close();
  }
});
