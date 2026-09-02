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

async function ishaanId(): Promise<string | null> {
  const { data } = await db.from('profiles').select('id').eq('username', 'ishaan').single();
  return data?.id ?? null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}

async function resolve(payload: WebhookPayload): Promise<Notification | null> {
  const r = payload.record;

  switch (payload.table) {
    case 'dm_messages': {
      const ishaan = await ishaanId();
      if (!ishaan) return null;
      const recipientId = r.sender_id === ishaan ? r.thread_user_id : ishaan;
      if (recipientId === r.sender_id) return null;
      const senderUsername = await usernameOf(r.sender_id);
      return {
        recipientId,
        title: senderUsername,
        body: truncate(r.body, 120),
        url: `/dm/${senderUsername}`,
      };
    }

    case 'likes': {
      if (!r.post_id || !r.user_id) return null;
      const { data: post } = await db.from('posts').select('author_id').eq('id', r.post_id).single();
      if (!post || post.author_id === r.user_id) return null;
      const likerUsername = await usernameOf(r.user_id);
      return {
        recipientId: post.author_id,
        title: 'Kalos',
        body: `${likerUsername} liked your photo`,
        url: `/post/${r.post_id}`,
      };
    }

    case 'comments': {
      if (!r.post_id || !r.author_id) return null;
      const { data: post } = await db.from('posts').select('author_id').eq('id', r.post_id).single();
      if (!post || post.author_id === r.author_id) return null;
      const commenterUsername = await usernameOf(r.author_id);
      return {
        recipientId: post.author_id,
        title: 'Kalos',
        body: `${commenterUsername}: ${truncate(r.body, 100)}`,
        url: `/post/${r.post_id}`,
      };
    }

    case 'follows': {
      if (!r.follower_id || !r.followee_id) return null;
      const followerUsername = await usernameOf(r.follower_id);
      return {
        recipientId: r.followee_id,
        title: 'Kalos',
        body: `${followerUsername} started following you`,
        url: `/profile/${followerUsername}`,
      };
    }

    default:
      return null;
  }
}

Deno.serve(async (req) => {
  const payload = (await req.json()) as WebhookPayload;

  const notification = await resolve(payload).catch((e) => {
    console.error('resolve failed', e);
    return null;
  });
  if (!notification) return new Response('skipped', { status: 200 });

  const { data: tokens } = await db
    .from('push_tokens')
    .select('token')
    .eq('user_id', notification.recipientId);
  if (!tokens?.length) return new Response('no tokens', { status: 200 });

  const messages = tokens.map((t) => ({
    to: t.token,
    title: notification.title,
    body: notification.body,
    data: { url: notification.url },
  }));

  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });

  return new Response(await res.text(), { status: res.ok ? 200 : 502 });
});
