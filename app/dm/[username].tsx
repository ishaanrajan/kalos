import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { formatCommentAge } from '../../components/CommentRow';
import { EmptyState } from '../../components/EmptyState';
import { Avatar } from '../../components/Avatar';
import { useDMThread, useMarkDMRead, useProfile, useSendDM, useTypingIndicator } from '../../lib/queries';
import { avatarUrl } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { nativeHeaderHeight, useTheme } from '../../lib/theme';
import type { DMMessage } from '../../lib/types';

/**
 * The old-Instagram "tap the heart instead of typing" send -- Bubble below
 * renders a message whose body is exactly this glyph as a large, bubble-less
 * heart instead of normal text.
 */
const BIG_HEART = '❤️';

/**
 * A DM thread. `username` names who this thread is *with*: for anyone but
 * ishaan, that's either "ishaan" or the Drake bot -- two separate threads,
 * both keyed to your own id as thread_user_id but different thread_with_id.
 * For ishaan, `username` is whichever person he opened from his inbox, and
 * thread_with_id is always his own id (his inbox only manages threads with
 * him, not e.g. someone's separate thread with Drake).
 */
export default function DMThread() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const router = useRouter();
  const { profile: me } = useAuth();
  const { data: other, isLoading: otherLoading } = useProfile(username);
  const [draft, setDraft] = useState('');
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const listRef = useRef<FlatList<DMMessage>>(null);

  const isIshaan = me?.username === 'ishaan';
  const threadUserId = isIshaan ? other?.id : me?.id;
  const threadWithId = isIshaan ? me?.id : other?.id;

  const { data: messages, isLoading: messagesLoading } = useDMThread(threadUserId, threadWithId);
  const sendDM = useSendDM(threadUserId, threadWithId);
  const markRead = useMarkDMRead(threadUserId, threadWithId);
  const { otherTyping, notifyTyping } = useTypingIndicator(threadUserId, threadWithId, me?.id ?? null);

  // Opening the thread is what "read" means -- mark whatever's here now.
  useEffect(() => {
    if (threadUserId && threadWithId) markRead.mutate();
  }, [threadUserId, threadWithId]);

  function submit() {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    sendDM.mutate(body, {
      onError: (e) => {
        // Give the typed message back instead of silently losing it.
        setDraft(body);
        Alert.alert('Could not send message', e instanceof Error ? e.message : undefined);
      },
    });
  }

  function sendHeart() {
    sendDM.mutate(BIG_HEART, {
      onError: (e) => Alert.alert('Could not send', e instanceof Error ? e.message : undefined),
    });
  }

  if (otherLoading || !me || !other) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      // The native header sits above this view and isn't part of its own
      // layout box, so KeyboardAvoidingView has no way to know its height on
      // its own. `nativeHeaderHeight` is the header's own content height (44
      // iOS / 56 Android); insets.top covers the rest (status bar / Dynamic
      // Island) and varies by device -- a hardcoded offset here was
      // previously too short on some phones, leaving the composer cramped
      // against the keyboard. `behavior: undefined` on Android relied on an
      // OS-level auto-resize that edge-to-edge display (Android default
      // since SDK 54) broke -- the composer sat entirely underneath the
      // keyboard, invisible, until this was made explicit.
      keyboardVerticalOffset={insets.top + nativeHeaderHeight}
    >
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Pressable onPress={() => router.push(`/profile/${other.username}`)} hitSlop={8}>
              <Text style={[styles.headerTitle, { color: colors.text }]}>{other.username}</Text>
            </Pressable>
          ),
        }}
      />

      <FlatList
        ref={listRef}
        data={messages ?? []}
        keyExtractor={(m) => m.id}
        inverted={false}
        contentContainerStyle={styles.listContent}
        // Messages are oldest-first, so "the bottom" is the newest one --
        // content size changes on the initial load and on every new message
        // (sent or received), so this covers both without needing to tell
        // the two apart.
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListFooterComponent={otherTyping ? <TypingBubble /> : null}
        ListEmptyComponent={
          messagesLoading ? (
            <ActivityIndicator style={styles.loading} />
          ) : (
            <EmptyState
              icon="send"
              title="No messages yet"
              body={isIshaan ? `Say hi to ${other.username}.` : `Say hi to ${other.username}.`}
            />
          )
        }
        renderItem={({ item, index }) => {
          const mine = item.sender_id === me.id;
          const prev = messages?.[index - 1];
          return (
            <Bubble
              message={item}
              mine={mine}
              // Threads can now carry messages from more than one sender
              // (ishaan, or a bot like the Drake account) -- label a received
              // message with who actually sent it, but only when that's a
              // change from the message above, same grouping iMessage uses.
              showSender={!mine && item.sender_id !== prev?.sender_id}
              showSeen={index === (messages?.length ?? 0) - 1 && mine && !!item.read_at}
            />
          );
        }}
      />

      <View
        style={[
          styles.composer,
          { paddingBottom: Math.max(10, insets.bottom), borderTopColor: colors.border },
        ]}
      >
        <TextInput
          style={[styles.input, { color: colors.text }]}
          placeholder="Message…"
          placeholderTextColor={colors.textSecondary}
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            if (text.trim()) notifyTyping();
          }}
          onSubmitEditing={submit}
          returnKeyType="send"
          multiline
        />
        {draft.trim() ? (
          <Pressable onPress={submit} disabled={sendDM.isPending} hitSlop={10}>
            <Text style={[styles.send, { color: colors.accent }]}>Send</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={sendHeart}
            disabled={sendDM.isPending}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Send a heart"
          >
            <Ionicons name="heart" size={26} color={colors.heart} />
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({
  message,
  mine,
  showSender,
  showSeen,
}: {
  message: DMMessage;
  mine: boolean;
  showSender: boolean;
  showSeen: boolean;
}) {
  const { colors } = useTheme();
  const isBigHeart = message.body.trim() === BIG_HEART;
  return (
    <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
      {showSender && message.sender && (
        <View style={styles.senderRow}>
          <Avatar url={avatarUrl(message.sender.avatar_path)} username={message.sender.username} size={16} />
          <Text style={[styles.senderName, { color: colors.textSecondary }]}>
            {message.sender.username}
          </Text>
        </View>
      )}
      {isBigHeart ? (
        // No bubble chrome at all -- old Instagram's tap-to-send heart
        // rendered as just a big glyph, not a normal message bubble.
        <Text style={styles.bigHeart}>{BIG_HEART}</Text>
      ) : (
        <View
          style={[
            styles.bubble,
            { backgroundColor: mine ? colors.accent : colors.surfaceAlt },
          ]}
        >
          <Text style={[styles.bubbleText, { color: mine ? '#ffffff' : colors.text }]}>
            {message.body}
          </Text>
        </View>
      )}
      <Text style={[styles.age, { color: colors.textSecondary }, mine && styles.ageMine]}>
        {formatCommentAge(message.created_at)}
      </Text>
      {/* Only ever under the very last message, like iMessage -- not one
          per read message, which would just be noise. */}
      {showSeen ? <Text style={[styles.seen, { color: colors.textSecondary }]}>Seen</Text> : null}
    </View>
  );
}

/** Three staggered pulsing dots, left-aligned like a received bubble. */
function TypingBubble() {
  const { colors } = useTheme();
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;

  useEffect(() => {
    const loops = dots.map((value, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(value, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(value, { toValue: 0.3, duration: 300, useNativeDriver: true }),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);

  return (
    <View style={styles.bubbleRow}>
      <View style={[styles.bubble, styles.typingBubble, { backgroundColor: colors.surfaceAlt }]}>
        {dots.map((value, i) => (
          <Animated.View
            key={i}
            style={[styles.typingDot, { backgroundColor: colors.textSecondary, opacity: value }]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loading: { marginTop: 40 },
  listContent: { flexGrow: 1, paddingVertical: 12 },
  bubbleRow: { paddingHorizontal: 16, marginVertical: 4, alignItems: 'flex-start' },
  bubbleRowMine: { alignItems: 'flex-end' },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 3, marginLeft: 4 },
  senderName: { fontSize: 11, fontWeight: '600' },
  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  bubbleText: { fontSize: 15, lineHeight: 20 },
  bigHeart: { fontSize: 56, lineHeight: 64 },
  age: { fontSize: 11, marginTop: 3, marginHorizontal: 4 },
  ageMine: { alignSelf: 'flex-end' },
  seen: { fontSize: 11, marginTop: 1, marginHorizontal: 4, alignSelf: 'flex-end' },
  typingBubble: { flexDirection: 'row', gap: 4, alignItems: 'center', paddingVertical: 13 },
  typingDot: { width: 6, height: 6, borderRadius: 3 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 6,
    maxHeight: 100,
  },
  send: { fontWeight: '600', fontSize: 14, paddingBottom: 6 },
});
