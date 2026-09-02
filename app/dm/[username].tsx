import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { formatCommentAge } from '../../components/CommentRow';
import { EmptyState } from '../../components/EmptyState';
import { useDMThread, useMarkDMRead, useProfile, useSendDM } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import type { DMMessage } from '../../lib/types';

/**
 * A DM thread. There is only ever one on either side of it: for anyone but
 * ishaan, `username` here is always "ishaan" and the thread is keyed to your
 * own id; for ishaan, `username` is whichever thread they opened from the
 * inbox, and the thread is keyed to that person's id.
 */
export default function DMThread() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { profile: me } = useAuth();
  const { data: other, isLoading: otherLoading } = useProfile(username);
  const [draft, setDraft] = useState('');

  const isIshaan = me?.username === 'ishaan';
  const threadUserId = isIshaan ? other?.id : me?.id;

  const { data: messages, isLoading: messagesLoading } = useDMThread(threadUserId);
  const sendDM = useSendDM(threadUserId);
  const markRead = useMarkDMRead(threadUserId);

  // Opening the thread is what "read" means -- mark whatever's here now.
  useEffect(() => {
    if (threadUserId) markRead.mutate();
  }, [threadUserId]);

  function submit() {
    const body = draft.trim();
    if (!body) return;
    sendDM.mutate(body);
    setDraft('');
  }

  if (otherLoading || !me || !other) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <Stack.Screen options={{ title: other.username }} />

      <FlatList
        data={messages ?? []}
        keyExtractor={(m) => m.id}
        inverted={false}
        contentContainerStyle={styles.listContent}
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
        renderItem={({ item, index }) => (
          <Bubble
            message={item}
            mine={item.sender_id === me.id}
            showSeen={
              index === (messages?.length ?? 0) - 1 && item.sender_id === me.id && !!item.read_at
            }
          />
        )}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder="Message…"
          placeholderTextColor="#8e8e8e"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          returnKeyType="send"
          multiline
        />
        <Pressable onPress={submit} disabled={!draft.trim() || sendDM.isPending} hitSlop={10}>
          <Text style={[styles.send, !draft.trim() && styles.sendDisabled]}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({
  message,
  mine,
  showSeen,
}: {
  message: DMMessage;
  mine: boolean;
  showSeen: boolean;
}) {
  return (
    <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{message.body}</Text>
      </View>
      <Text style={[styles.age, mine && styles.ageMine]}>{formatCommentAge(message.created_at)}</Text>
      {/* Only ever under the very last message, like iMessage -- not one
          per read message, which would just be noise. */}
      {showSeen ? <Text style={styles.seen}>Seen</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  loading: { marginTop: 40 },
  listContent: { flexGrow: 1, paddingVertical: 12 },
  bubbleRow: { paddingHorizontal: 16, marginVertical: 4, alignItems: 'flex-start' },
  bubbleRowMine: { alignItems: 'flex-end' },
  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  bubbleTheirs: { backgroundColor: '#efefef' },
  bubbleMine: { backgroundColor: '#3897f0' },
  bubbleText: { fontSize: 15, color: '#262626', lineHeight: 20 },
  bubbleTextMine: { color: '#fff' },
  age: { fontSize: 11, color: '#8e8e8e', marginTop: 3, marginHorizontal: 4 },
  ageMine: { alignSelf: 'flex-end' },
  seen: { fontSize: 11, color: '#8e8e8e', marginTop: 1, marginHorizontal: 4, alignSelf: 'flex-end' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#dbdbdb',
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#262626',
    paddingVertical: 6,
    maxHeight: 100,
  },
  send: { color: '#3897f0', fontWeight: '600', fontSize: 14, paddingBottom: 6 },
  sendDisabled: { opacity: 0.4 },
});
