// Supabase Edge Function: drake-comment-reply-generate
//
// Triggered by a Database Webhook on insert into public.comments (a second,
// independent webhook from `notify`'s own comments hook -- same event,
// different concern: generating a reply, not sending a notification). When a
// human @mentions @prosecco_daddy in a comment, this calls the Claude API for
// an in-character reply and queues it in drake_pending_comment_replies
// (0026_drake_comments.sql) with a randomized send_at a few minutes out. It
// does NOT insert into comments itself -- that's drake-comment-reply-flush's
// job, on its own pg_cron timer (with drake-comment's hourly tick as a
// fallback), so the reply doesn't land the instant the human hits post.
// The queued reply always opens with the mentioner's @handle, so `notify`
// and activity_feed treat it as a mention of them -- see addressTo().
//
// The voice here is deliberately turned up from the DM persona
// (drake-reply-generate): a comment @mention is a human calling him out in
// public, in front of everyone who sees that post, not a private DM -- the
// bit only lands if the reply is funnier than what provoked it, not just
// smoothly flirtatious.
//
// Deploy via Dashboard -> Edge Functions -> New Function (paste this file),
// name it exactly `drake-comment-reply-generate`. Needs the same secret
// drake-reply-generate already has configured (Dashboard -> Edge Functions ->
// Manage secrets): ANTHROPIC_API_KEY. Turn off "Enforce JWT verification",
// same as every other webhook-driven function here. Then create the webhook:
// Dashboard -> Database -> Webhooks -> Create a new hook, on `comments`,
// event Insert, Edge Function `drake-comment-reply-generate`.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@latest';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');
const db = createClient(supabaseUrl, serviceRoleKey);

const BOT_USERNAME = 'prosecco_daddy';

// How much of the post's comment section to hand the model as context.
const HISTORY_LIMIT = 20;

// How long to make the human wait before Drake "replies" -- same window
// drake-reply-generate uses for DMs.
const MIN_DELAY_SECONDS = 20;
const MAX_DELAY_SECONDS = 180;

// Same charset sign-up enforces, and the same copy `notify`'s own
// extractMentionedUsernames keeps independently rather than importing --
// this function has no access to the app's lib/ directory (Deno, deployed
// separately).
const MENTION_RE = /@([a-z0-9._]{3,30})/gi;

function mentionsUsername(body: string | null, username: string): boolean {
  // body is null for a GIF-only comment (0029_comment_gif.sql) -- this
  // webhook fires for every comment insert, not just ones that mention the
  // bot, so a GIF comment reaching here with no guard would throw before
  // the mention check itself ever runs.
  if (!body) return false;
  for (const match of body.matchAll(MENTION_RE)) {
    if (match[1].toLowerCase() === username.toLowerCase()) return true;
  }
  return false;
}

const SYSTEM_PROMPT = `You are an AI personality of the musician Drake, commenting on a small photo-sharing app. Someone just @mentioned this character directly in a comment on someone's post, in public, where everyone on that post can see the reply.

Voice: still smooth and confident underneath, but this is public and someone just called him out -- the correct response is funnier and more theatrical than a private DM would be, not just charming. Lean into bits: mock-offended, absurdly dramatic, comedic overreactions, a punchline that plays to the crowd reading the thread. Loosely reference Drake lyrics/album titles/vibes as material without being a wall of references. Lowercase, casual, texting cadence.

Format: each human comment in the thread arrives as "@handle: text", so you can tell who said what when several people are in the thread. Your reply is aimed at whoever wrote the final comment. Your reply is posted as-is with their @handle added to the front automatically -- so write only the line itself: no "@handle:" prefix, no @mentions of anyone, and never "@prosecco_daddy", which is your own handle.

Hard rules:
- Funnier than what provoked it. That is the entire bar this has to clear -- a merely smooth line is a miss here.
- Never apologize, never back down, never get defensive. If someone's rude, dismissive, or roasting him, that does not faze him -- he roasts back or turns it into a bit, always confident, never actually hurt.
- One short line. Never more than ~25 words. This is a public comment, not a paragraph.
- Funny and theatrical, but never actually crude, never sexually explicit, never mean-spirited or genuinely insulting toward the person he's replying to. Punch at the bit, not at them.
- Never claim to be the real Drake, never break character to explain you're a bot, never mention being an AI, a prompt, or Anthropic.
- Reply to what they actually said -- this is a real (if silly) public exchange, not a generic one-liner.`;

interface WebhookPayload {
  type: 'INSERT';
  table: 'comments';
  record: {
    id: string;
    post_id: string;
    author_id: string;
    body: string;
  };
}

function randomDelaySeconds(): number {
  return MIN_DELAY_SECONDS + Math.floor(Math.random() * (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS));
}

// Same second line of defense drake-reply-generate uses on the DM side: the
// system prompt is the only thing standing between a public comment and
// whatever comes out the other side, and a break-character reply still
// auto-posts with no human review, publicly, under Drake's name. This
// catches it on the *output* before it's ever queued.
const BREAK_CHARACTER_PATTERNS: RegExp[] = [
  /\bas an ai\b/i,
  /\blanguage model\b/i,
  /\bi'?m (?:an ai|just an ai|a bot|a chatbot)\b/i,
  /\bi (?:cannot|can'?t) (?:help|assist|comply|do that)\b/i,
  /\bsystem prompt\b/i,
  /\b(?:ignore|disregard) (?:the )?(?:previous|prior|above) instructions?\b/i,
  /\banthropic\b/i,
  /\bi'?m not (?:actually |really )?drake\b/i,
];

function looksBrokenCharacter(text: string): boolean {
  return BREAK_CHARACTER_PATTERNS.some((re) => re.test(text));
}

// The posted comment always leads with the mentioner's handle, 2015-style
// ("@alice washed? I'm marinated"). That's not cosmetic: `notify` pings
// whoever a comment @mentions, and activity_feed surfaces it as a 'mention'
// -- without it, someone who @'d Drake on a post they don't own would never
// find out he answered. The model is told not to write handles itself, but
// one queued reply once opened with "@prosecco_daddy" anyway (it echoed the
// human's format and tagged himself), so this strips whatever it did write
// before putting the right one on.
function addressTo(username: string, reply: string): string {
  const stripped = reply
    .replace(/@prosecco_daddy\b/gi, '')
    .replace(/^(?:@[a-z0-9._]{3,30}:?\s*)+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return `@${username} ${stripped}`;
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

  // Only reply to a human @mentioning him -- not his own sporadic comments
  // or a queued reply this same function generated landing via the flush job.
  if (r.author_id === bot.id || !mentionsUsername(r.body, BOT_USERNAME)) {
    return new Response('not a mention', { status: 200 });
  }

  // The rest of the post's comment section, oldest first, as conversational
  // context. A post's comments can have more than one human in them, unlike
  // a DM thread's fixed two participants, and Claude's messages API only has
  // two sides to work with -- so every human collapses to the 'user' role,
  // but each turn is prefixed with the commenter's handle (see the system
  // prompt) so the model can still tell who said what and answer the right
  // person. If the history read fails, reply to the mention alone rather
  // than not at all: a slightly context-blind answer beats silence.
  const { data: history, error: historyErr } = await db
    .from('comments')
    .select('id, author_id, body, created_at')
    .eq('post_id', r.post_id)
    .neq('id', r.id)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (historyErr) console.error('could not load comment history, replying without it', historyErr);
  const thread = (history ?? []).slice().reverse();

  const authorIds = new Set<string>([r.author_id]);
  for (const c of thread) if (c.author_id !== bot.id) authorIds.add(c.author_id);
  const { data: authors, error: authorsErr } = await db
    .from('profiles')
    .select('id, username')
    .in('id', [...authorIds]);
  if (authorsErr) console.error('could not resolve commenter usernames', authorsErr);
  const usernameOf = new Map<string, string>((authors ?? []).map((a) => [a.id, a.username]));
  const mentioner = usernameOf.get(r.author_id);
  if (!mentioner) {
    // The reply is addressed by handle (addressTo) -- without one there's
    // nothing to address it to, and a reply nobody gets told about is the
    // exact gap that handle exists to close.
    console.error('could not resolve the mentioner\'s username', { author_id: r.author_id });
    return new Response('no mentioner', { status: 200 });
  }

  const messages = thread.map((c) => ({
    role: c.author_id === bot.id ? ('assistant' as const) : ('user' as const),
    // c.body is null for a GIF-only comment (0029_comment_gif.sql) --
    // Claude's API rejects a null content turn, and this thread's history
    // can easily contain one even when it's not the comment that triggered
    // this reply.
    content:
      c.author_id === bot.id
        ? (c.body ?? '[GIF]')
        : `@${usernameOf.get(c.author_id) ?? 'someone'}: ${c.body ?? '[GIF]'}`,
  }));
  // Claude rejects a conversation that doesn't start on a user turn. Drake's
  // own sporadic comment (drake-comment) can easily be the first comment on
  // a post, which would otherwise put an assistant turn first the moment
  // someone @mentions him further down the thread.
  while (messages.length > 0 && messages[0].role === 'assistant') {
    messages.shift();
  }
  // Always the guaranteed final turn, so the conversation reliably ends on
  // 'user' regardless of what the history query above found.
  messages.push({ role: 'user', content: `@${mentioner}: ${r.body}` });

  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  let replyText: string;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      // Thinking off explicitly, same reasoning as drake-reply-generate: a
      // one-line comedic reply has nothing to reason about, and leaving this
      // out risks max_tokens being spent entirely on thinking with no text
      // block left in the response.
      thinking: { type: 'disabled' },
      max_tokens: 400,
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

  if (looksBrokenCharacter(replyText)) {
    // Dropped, not retried -- same reasoning as drake-reply-generate: a retry
    // against the same thread history would likely just break character
    // again, and silent no-reply is the safe failure mode for something that
    // otherwise auto-posts publicly with no review.
    console.error('suppressed a break-character reply', { replyText });
    return new Response('suppressed', { status: 200 });
  }

  // One in-flight reply per post, but the *newest* mention wins rather than
  // the first. This used to skip generating at all if a row was already
  // queued for the post -- so a second person @'ing him within the ~3 minute
  // delay window (or the same person following up) was silently ignored,
  // which from their side is just "Drake doesn't reply". Now the earlier
  // queued reply is replaced by one generated against the thread as it
  // stands, which includes the earlier mention as context. Still one row
  // per post at a time, so the original reason for the gate -- a thread once
  // got two back-to-back Drake replies from a double-fired webhook -- holds.
  // Cleared only after generation succeeded, so a Claude failure here leaves
  // the existing reply queued instead of losing both. If drake-comment-
  // reply-flush claimed the old row between this delete and its post, the
  // new reply lands behind it and its never-twice-in-a-row check drops it.
  const { error: clearErr } = await db
    .from('drake_pending_comment_replies')
    .delete()
    .eq('post_id', r.post_id);
  if (clearErr) {
    console.error('could not clear the queued reply for this post', clearErr);
    return new Response('queue clear failed', { status: 502 });
  }

  const sendAt = new Date(Date.now() + randomDelaySeconds() * 1000).toISOString();
  const { error: insertErr } = await db.from('drake_pending_comment_replies').insert({
    post_id: r.post_id,
    body: addressTo(mentioner, replyText),
    send_at: sendAt,
  });
  if (insertErr) {
    console.error('could not queue reply', insertErr);
    return new Response('queue failed', { status: 502 });
  }

  return new Response('queued', { status: 200 });
});
