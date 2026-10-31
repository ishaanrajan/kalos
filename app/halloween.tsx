import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { EmptyState } from '../components/EmptyState';
import { formatCommentAge } from '../components/CommentRow';
import { useGroupChat, useGroupChatAlias, useProfile, useSendGroupChat } from '../lib/queries';
import { avatarUrl } from '../lib/supabase';
import { nativeHeaderHeight, useTheme } from '../lib/theme';
import type { GroupChatMessage } from '../lib/types';

const DRAKE = 'prosecco_daddy';

/** One room, everyone in it, Halloween only (0047_halloween_chat.sql). */
export default function HalloweenChat() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<GroupChatMessage>>(null);
  const [draft, setDraft] = useState('');
  const { data: messages, isLoading, isError, refetch } = useGroupChat();
  const send = useSendGroupChat();
  const { data: myAlias } = useGroupChatAlias();
  const { data: drake } = useProfile(DRAKE);

  function submit() {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    send.mutate(body, {
      onError: (e) => {
        setDraft(body);
        Alert.alert('Could not send message', e instanceof Error ? e.message : undefined);
      },
    });
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={insets.top + nativeHeaderHeight}
    >
      <FlatList
        ref={listRef}
        data={messages ?? []}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListHeaderComponent={
          myAlias ? (
            <Text style={[styles.youAre, { color: colors.textSecondary }]}>
              Everyone's anonymous tonight. You are {myAlias}.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator style={styles.loading} />
          ) : isError ? (
            <EmptyState icon="alert-circle" title="Couldn't load the chat" actionLabel="Try again" onAction={() => refetch()} />
          ) : (
            <EmptyState icon="send" title="Nobody's said anything yet" body="Be the first. Boo." />
          )
        }
        renderItem={({ item, index }) => {
          const mine = !!myAlias && item.alias === myAlias;
          const isDrake = item.alias === DRAKE;
          const showSender = !mine && item.alias !== messages?.[index - 1]?.alias;
          return (
            <View style={[styles.row, mine && styles.rowMine]}>
              {showSender ? (
                isDrake && drake ? (
                  // The one un-anonymised voice in the room.
                  <Pressable
                    style={styles.senderRow}
                    onPress={() => router.push(`/profile/${drake.username}`)}
                    hitSlop={6}
                  >
                    <Avatar url={avatarUrl(drake.avatar_path)} username={drake.username} size={16} />
                    <Text style={[styles.senderName, { color: colors.textSecondary }]}>{drake.username}</Text>
                  </Pressable>
                ) : (
                  <Text style={[styles.senderName, styles.senderRow, { color: colors.textSecondary }]}>
                    {item.alias}
                  </Text>
                )
              ) : null}
              <View style={[styles.bubble, { backgroundColor: mine ? colors.accent : colors.surfaceAlt }]}>
                <Text style={[styles.bubbleText, { color: mine ? '#ffffff' : colors.text }]}>{item.body}</Text>
              </View>
              <Text style={[styles.age, { color: colors.textSecondary }]}>{formatCommentAge(item.created_at)}</Text>
            </View>
          );
        }}
      />

      <View style={[styles.composer, { paddingBottom: Math.max(10, insets.bottom), borderTopColor: colors.border }]}>
        <TextInput
          style={[styles.input, { color: colors.text }]}
          placeholder="Say something spooky…"
          placeholderTextColor={colors.textSecondary}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          returnKeyType="send"
          submitBehavior="submit"
          multiline
          maxLength={1000}
        />
        <Pressable onPress={submit} disabled={!draft.trim() || send.isPending} hitSlop={10}>
          <Text style={[styles.send, { color: colors.accent, opacity: draft.trim() ? 1 : 0.4 }]}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loading: { marginTop: 40 },
  youAre: { textAlign: 'center', fontSize: 12, paddingHorizontal: 24, paddingBottom: 12 },
  listContent: { flexGrow: 1, paddingVertical: 12 },
  row: { paddingHorizontal: 16, marginVertical: 4, alignItems: 'flex-start' },
  rowMine: { alignItems: 'flex-end' },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 3, marginLeft: 4 },
  senderName: { fontSize: 11, fontWeight: '600' },
  bubble: { maxWidth: '78%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  bubbleText: { fontSize: 15, lineHeight: 20 },
  age: { fontSize: 11, marginTop: 3, marginHorizontal: 4 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontSize: 15, paddingVertical: 6, maxHeight: 100 },
  send: { fontWeight: '600', fontSize: 14, paddingBottom: 6 },
});
