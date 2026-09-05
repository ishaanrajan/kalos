// Supabase Edge Function: notify
//
// Triggered by Database Webhooks (see 0009_notifications.sql) on insert into
// dm_messages, likes, comments, and follows. Resolves who should hear about
// it, skips notifying someone about their own action, and pushes through
// Expo's push API to every token that person has registered.
//
// Deploy via the Supabase Dashboard -> Edge Functions -> New Function
// (paste this file), or `supabase functions deploy notify` if the CLI is
// linked. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
// automatically by the Edge Functions runtime -- nothing to configure.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(supabaseUrl, serviceRoleKey);

interface WebhookPayload {
  type: 'INSERT';
  table: 'dm_messages' | 'likes' | 'comments' | 'follows';
  record: Record<string, any>;
}

interface Notification {
  recipientId: string;
  title: string;
  body: string;
  url: string;
}

async function usernameOf(id: string): Promise<string> {
  const { data } = await db.from('profiles').select('username').eq('id', id).single();
  return data?.username ?? 'someone';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}

// Same charset sign-up enforces (lowercase letters, digits, dots,
// underscores, 3-30 chars) -- mirrors lib/mentions.ts's MENTION_RE. Kept as
// a separate copy rather than a shared import since this function has no
// access to the app's lib/ directory (Deno, deployed independently).
const MENTION_RE = /@([a-z0-9._]{3,30})/gi;

function extractMentionedUsernames(body: string): string[] {
  const usernames = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    usernames.add(match[1].toLowerCase());
  }
  return [...usernames];
}

// One event can fan out to more than one person -- a comment notifies its
// post's author AND anyone @mentioned in it, and those can be different
// people (or nobody, if the commenter only mentioned themselves or the
// author, both filtered out below).
async function resolve(payload: WebhookPayload): Promise<Notification[]> {
  const r = payload.record;

  switch (payload.table) {
    case 'dm_messages': {
      // A thread's identity is (thread_user_id, thread_with_id) since 0014 --
      // the recipient is whichever of the two isn't the sender. This used to
      // hardcode "recipient is ishaan unless ishaan is the sender," which
      // predates Drake having a thread of his own: any Drake DM to a regular
      // user has sender_id = drake, which is never ishaan, so the old logic
      // always resolved the recipient to ishaan -- he was getting pushed a
      // notification for every Drake DM sent to anyone.
      const recipientId = r.sender_id === r.thread_user_id ? r.thread_with_id : r.thread_user_id;
      if (recipientId === r.sender_id) return [];
      const senderUsername = await usernameOf(r.sender_id);
      return [
        {
          recipientId,
          title: senderUsername,
          body: truncate(r.body, 120),
          url: `/dm/${senderUsername}`,
        },
      ];
    }

    case 'likes': {
      if (!r.post_id || !r.user_id) return [];
      const { data: post } = await db.from('posts').select('author_id').eq('id', r.post_id).single();
      if (!post || post.author_id === r.user_id) return [];
      const likerUsername = await usernameOf(r.user_id);
      return [
        {
          recipientId: post.author_id,
          title: 'Kalos',
          body: `${likerUsername} liked your photo`,
          url: `/post/${r.post_id}`,
        },
      ];
    }

    case 'comments': {
      if (!r.post_id || !r.author_id) return [];
      const { data: post } = await db.from('posts').select('author_id').eq('id', r.post_id).single();
      if (!post) return [];
      const commenterUsername = await usernameOf(r.author_id);
      const notifications: Notification[] = [];

      if (post.author_id !== r.author_id) {
        notifications.push({
          recipientId: post.author_id,
          title: 'Kalos',
          body: `${commenterUsername}: ${truncate(r.body, 100)}`,
          url: `/post/${r.post_id}`,
        });
      }

      const mentionedUsernames = extractMentionedUsernames(r.body ?? '');
      if (mentionedUsernames.length > 0) {
        const { data: mentioned } = await db
          .from('profiles')
          .select('id, username')
          .in('username', mentionedUsernames);
        for (const m of mentioned ?? []) {
          // No self-mention ping, and no double ping for the post's own
          // author -- they already got the comment notification above.
          if (m.id === r.author_id || m.id === post.author_id) continue;
          notifications.push({
            recipientId: m.id,
            title: 'Kalos',
            body: `${commenterUsername} mentioned you: ${truncate(r.body, 100)}`,
            url: `/post/${r.post_id}`,
          });
        }
      }

      return notifications;
    }

    case 'follows': {
      if (!r.follower_id || !r.followee_id) return [];
      const followerUsername = await usernameOf(r.follower_id);
      return [
        {
          recipientId: r.followee_id,
          title: 'Kalos',
          body: `${followerUsername} started following you`,
          url: `/profile/${followerUsername}`,
        },
      ];
    }

    default:
      return [];
  }
}

async function sendPush(notification: Notification): Promise<void> {
  const { data: tokens } = await db
    .from('push_tokens')
    .select('token')
    .eq('user_id', notification.recipientId);
  if (!tokens?.length) return;

  const messages = tokens.map((t) => ({
    to: t.token,
    title: notification.title,
    body: notification.body,
    data: { url: notification.url },
  }));

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
}

Deno.serve(async (req) => {
  const payload = (await req.json()) as WebhookPayload;

  const notifications = await resolve(payload).catch((e) => {
    console.error('resolve failed', e);
    return [] as Notification[];
  });
  if (notifications.length === 0) return new Response('skipped', { status: 200 });

  for (const notification of notifications) {
    await sendPush(notification);
  }

  return new Response(`sent ${notifications.length}`, { status: 200 });
});
