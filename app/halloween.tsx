import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { Redirect, Stack, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar } from '../components/Avatar';
import { LibraryPicker } from '../components/LibraryPicker';
import { EmptyState } from '../components/EmptyState';
import { formatCommentAge } from '../components/CommentRow';
import { useGroupChat, useGroupChatAlias, useHalloweenChatAccess, useProfile, useSendGroupChat } from '../lib/queries';
import type { BakedImage } from '../lib/bake';
import { discardChatPhoto, prepareChatPhoto, uploadChatPhoto } from '../lib/chatPhoto';
import { avatarUrl, chatPhotoUrl } from '../lib/supabase';
import { HALLOWEEN_CHAT_ICON } from '../lib/halloween';
import { nativeHeaderHeight, useTheme } from '../lib/theme';
import type { GroupChatMessage } from '../lib/types';

// The two accounts that appear as themselves; everyone else is a random alias.
const DRAKE = 'prosecco_daddy';
const ISHAAN = 'ishaan';

/** One room, everyone in it, Halloween only (0047_halloween_chat.sql). */
export default function HalloweenChat() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<GroupChatMessage>>(null);
  const [draft, setDraft] = useState('');
  const [picking, setPicking] = useState(false);
  const [staged, setStaged] = useState<BakedImage | null>(null);
  const [sendingPhoto, setSendingPhoto] = useState(false);
  const { data: messages, isLoading, isError, refetch } = useGroupChat();
  const send = useSendGroupChat();
  const { data: myAlias } = useGroupChatAlias();
  const { data: drake } = useProfile(DRAKE);
  const { data: ishaan } = useProfile(ISHAAN);
  const { data: inChat } = useHalloweenChatAccess();

  function submit() {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    send.mutate({ body }, {
      onError: (e) => {
        setDraft(body);
        Alert.alert('Could not send message', e instanceof Error ? e.message : undefined);
      },
    });
  }

  async function openPicker() {
    const permission = await MediaLibrary.requestPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photo access needed', 'Turn on photo library access in Settings to send a picture.');
      return;
    }
    setPicking(true);
  }

  async function sendStaged() {
    if (!staged) return;
    setSendingPhoto(true);
    try {
      const photo = await uploadChatPhoto(staged);
      await send.mutateAsync({ body: '', photo });
      discardChatPhoto(staged);
      setStaged(null);
    } catch (e) {
      Alert.alert('Could not send photo', e instanceof Error ? e.message : undefined);
    } finally {
      setSendingPhoto(false);
    }
  }

  function cancelStaged() {
    if (staged) discardChatPhoto(staged);
    setStaged(null);
  }

  if (inChat === false) return <Redirect href="/dm" />;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={insets.top + nativeHeaderHeight}
    >
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.headerTitle}>
              <Image source={HALLOWEEN_CHAT_ICON} style={styles.headerIcon} contentFit="cover" />
              <Text style={[styles.headerText, { color: colors.text }]}>Halloween Chat</Text>
            </View>
          ),
        }}
      />
      <FlatList
        ref={listRef}
        data={messages ?? []}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListHeaderComponent={
          <View style={styles.intro}>
            <Image source={HALLOWEEN_CHAT_ICON} style={styles.introIcon} contentFit="cover" />
            {myAlias ? (
              <Text style={[styles.youAre, { color: colors.textSecondary }]}>
                {myAlias === ISHAAN
                  ? "Everyone's anonymous tonight. Except you."
                  : `Everyone's anonymous tonight. You are ${myAlias}.`}
              </Text>
            ) : null}
          </View>
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
          const revealed = item.alias === DRAKE ? drake : item.alias === ISHAAN ? ishaan : undefined;
          const showSender = !mine && item.alias !== messages?.[index - 1]?.alias;
          return (
            <View style={[styles.row, mine && styles.rowMine]}>
              {showSender ? (
                revealed ? (
                  // The un-anonymised voices in the room.
                  <Pressable
                    style={styles.senderRow}
                    onPress={() => router.push(`/profile/${revealed.username}`)}
                    hitSlop={6}
                  >
                    <Avatar url={avatarUrl(revealed.avatar_path)} username={revealed.username} size={16} />
                    <Text style={[styles.senderName, { color: colors.textSecondary }]}>{revealed.username}</Text>
                  </Pressable>
                ) : (
                  <Text style={[styles.senderName, styles.senderRow, { color: colors.textSecondary }]}>
                    {item.alias}
                  </Text>
                )
              ) : null}
              {item.image_path && item.image_w && item.image_h ? (
                <Image
                  source={chatPhotoUrl(item.image_path)}
                  style={[styles.photo, { aspectRatio: item.image_w / item.image_h }]}
                  contentFit="cover"
                  transition={150}
                  cachePolicy="memory-disk"
                />
              ) : null}
              {item.body ? (
                <View style={[styles.bubble, item.image_path && styles.captionBubble, { backgroundColor: mine ? colors.accent : colors.surfaceAlt }]}>
                  <Text style={[styles.bubbleText, { color: mine ? '#ffffff' : colors.text }]}>{item.body}</Text>
                </View>
              ) : null}
              <Text style={[styles.age, { color: colors.textSecondary }]}>{formatCommentAge(item.created_at)}</Text>
            </View>
          );
        }}
      />

      <View style={[styles.composer, { paddingBottom: Math.max(10, insets.bottom), borderTopColor: colors.border }]}>
        <Pressable onPress={openPicker} hitSlop={10} accessibilityRole="button" accessibilityLabel="Send a photo">
          <Ionicons name="image-outline" size={26} color={colors.accent} />
        </Pressable>
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

      <Modal visible={picking} animationType="slide" onRequestClose={() => setPicking(false)}>
        <LibraryPicker
          onCancel={() => setPicking(false)}
          onNext={async (pick) => {
            try {
              setStaged(await prepareChatPhoto(pick));
              setPicking(false);
            } catch (e) {
              Alert.alert('Could not use that photo', e instanceof Error ? e.message : undefined);
            }
          }}
        />
      </Modal>

      <Modal visible={!!staged} animationType="fade" onRequestClose={cancelStaged}>
        <SafeAreaView style={styles.stage}>
          <View style={styles.stageBar}>
            <Pressable onPress={cancelStaged} disabled={sendingPhoto} hitSlop={12}>
              <Text style={[styles.stageAction, { color: '#fff', opacity: sendingPhoto ? 0.4 : 1 }]}>Cancel</Text>
            </Pressable>
            <Pressable onPress={sendStaged} disabled={sendingPhoto} hitSlop={12}>
              {sendingPhoto ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Text style={[styles.stageAction, { color: colors.accent, fontWeight: '700' }]}>Send</Text>
              )}
            </Pressable>
          </View>
          {staged ? <Image source={staged.uri} style={styles.stageImage} contentFit="contain" /> : null}
        </SafeAreaView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loading: { marginTop: 40 },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerIcon: { width: 28, height: 28, borderRadius: 14 },
  headerText: { fontSize: 17, fontWeight: '600' },
  intro: { alignItems: 'center', paddingTop: 8 },
  introIcon: { width: 88, height: 88, borderRadius: 44, marginBottom: 10 },
  youAre: { textAlign: 'center', fontSize: 12, paddingHorizontal: 24, paddingBottom: 12 },
  listContent: { flexGrow: 1, paddingVertical: 12 },
  row: { paddingHorizontal: 16, marginVertical: 4, alignItems: 'flex-start' },
  rowMine: { alignItems: 'flex-end' },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 3, marginLeft: 4 },
  senderName: { fontSize: 11, fontWeight: '600' },
  bubble: { maxWidth: '78%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  photo: { width: 240, maxHeight: 360, borderRadius: 16, backgroundColor: '#222' },
  captionBubble: { marginTop: 4 },
  stage: { flex: 1, backgroundColor: '#000' },
  stageBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  stageAction: { fontSize: 16 },
  stageImage: { flex: 1 },
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
