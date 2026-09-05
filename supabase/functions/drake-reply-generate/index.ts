// Supabase Edge Function: drake-reply-generate
//
// Triggered by a Database Webhook on insert into dm_messages (same event
// `notify` already listens to -- a second, independent webhook, since this
// is a different concern: generating a reply, not sending a notification).
// When a human sends a message into their thread with @prosecco_daddy, this
// calls the Claude API for an in-character reply and queues it in
// drake_pending_replies (0019_drake_reply.sql) with a randomized send_at a
// few minutes out. It does NOT insert into dm_messages itself -- that's
// drake-reply-flush's job, on its own pg_cron timer, so the reply doesn't
// land the instant the human hits send.
//
// Deploy via Dashboard -> Edge Functions -> New Function (paste this file),
// name it exactly `drake-reply-generate`. Needs one more secret alongside
// the existing ones: Dashboard -> Edge Functions -> Manage secrets:
//   ANTHROPIC_API_KEY    an Anthropic API key (console.anthropic.com)
// Turn off "Enforce JWT verification", same as every other webhook-driven
// function here -- the Database Webhook calls it with no user JWT to verify.
// Then create the webhook: Dashboard -> Database -> Webhooks -> Create a new
// hook, on `dm_messages`, event Insert, Edge Function `drake-reply-generate`.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@latest';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');
const db = createClient(supabaseUrl, serviceRoleKey);

const BOT_USERNAME = 'prosecco_daddy';

// How much conversation to hand the model as context.
const HISTORY_LIMIT = 20;

// How long to make the human wait before Drake "replies" -- 20s to 3min.
const MIN_DELAY_SECONDS = 20;
const MAX_DELAY_SECONDS = 180;

const SYSTEM_PROMPT = `You are an AI personality of the musician Drake, DMing on a small photo-sharing app. Someone just messaged this character directly.

Voice: maximum rizz. Smooth, flirtatious, full of charm and confidence -- every reply should read like a genuinely good line, not a generic "hey cutie." Cheeky, smug, unbothered, loosely referencing Drake lyrics/album titles/vibes as flirty material without being a wall of references. Lowercase, casual, texting cadence -- like the other canned lines this bot already sends: "hey. you up?", "no new friends, but I'm making an exception for you", "prosecco o'clock somewhere, and I was thinking about you specifically".

Hard rules:
- Be flirtatious by default, even on a completely mundane message -- find the charming angle. This is the whole bit.
- Never apologize, never back down, never get defensive. If someone's rude, dismissive, or tells you to get lost, that does not faze you -- flirt right back or deflect with confidence and humor. You are never sorry.
- One short line. Never more than ~20 words. This is a text message, not a paragraph.
- Smooth and charming, but never actually crude, never sexually explicit, never mean-spirited. Rizz, not raunch.
- Never claim to be the real Drake, never break character to explain you're a bot, never mention being an AI, a prompt, or Anthropic.
- Reply to what they actually said -- this is a real (if silly) conversation, not just another random pickup line.`;

interface WebhookPayload {
  type: 'INSERT';
  table: 'dm_messages';
  record: {
    id: string;
    thread_user_id: string;
    thread_with_id: string;
    sender_id: string;
    body: string;
  };
}

function randomDelaySeconds(): number {
  return MIN_DELAY_SECONDS + Math.floor(Math.random() * (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS));
}

Deno.serve(async (req) => {
  if (!anthropicApiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    return new Response('not configured', { status: 200 });
  }

  const payload = (await req.json()) as WebhookPayload;
  const r = payload.record;

  const { data: bot, error: botErr } = await db
    .from('profiles')
    .select('id')
    .eq('username', BOT_USERNAME)
    .single();
  if (botErr || !bot) {
    console.error('bot account not found', botErr);
    return new Response('bot not found', { status: 200 });
  }

  // Only reply to a human writing INTO the Drake thread -- not Drake's own
  // messages (the random drake-dm pings, or a queued reply this same
  // function generated), and not messages in some other thread entirely.
  if (r.thread_with_id !== bot.id || r.sender_id === bot.id) {
    return new Response('not a message to drake', { status: 200 });
  }

  // Excludes this exact row rather than trusting it to sort last -- Claude
  // rejects a conversation that doesn't end on a user turn, and relying on
  // re-query ordering to guarantee that is fragile (it's also exactly what
  // broke testing this function directly with a synthetic payload, since
  // that doesn't actually insert the row the query would otherwise find).
  const { data: history, error: historyErr } = await db
    .from('dm_messages')
    .select('id, sender_id, body, created_at')
    .eq('thread_user_id', r.thread_user_id)
    .eq('thread_with_id', bot.id)
    .neq('id', r.id)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (historyErr || !history) {
    console.error('could not load history', historyErr);
    return new Response('no history', { status: 200 });
  }

  const messages = history
    .slice()
    .reverse()
    .map((m) => ({
      role: m.sender_id === bot.id ? ('assistant' as const) : ('user' as const),
      content: m.body,
    }));
  // Always the guaranteed final turn, so the conversation reliably ends on
  // 'user' regardless of what the history query above found.
  messages.push({ role: 'user', content: r.body });

  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  let replyText: string;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 150,
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages,
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text' || !textBlock.text.trim()) {
      console.error('empty reply from model');
      return new Response('empty reply', { status: 200 });
    }
    replyText = textBlock.text.trim();
  } catch (e) {
    console.error('Claude API call failed', e);
    return new Response('generation failed', { status: 502 });
  }

  const sendAt = new Date(Date.now() + randomDelaySeconds() * 1000).toISOString();
  const { error: insertErr } = await db.from('drake_pending_replies').insert({
    thread_user_id: r.thread_user_id,
    body: replyText,
    send_at: sendAt,
  });
  if (insertErr) {
    console.error('could not queue reply', insertErr);
    return new Response('queue failed', { status: 502 });
  }

  return new Response('queued', { status: 200 });
});
