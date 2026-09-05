import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';

export default function SignIn() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { colors, wordmarkFontFamily } = useTheme();

  const disabled = busy || !email.trim() || !password;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.card}>
        <Text style={[styles.wordmark, { color: colors.text, fontFamily: wordmarkFontFamily }]}>
          Kalos
        </Text>
        <Text style={[styles.tagline, { color: colors.textSecondary }]}>
          Photos from people you actually follow.
        </Text>

        <TextInput
          style={[
            styles.input,
            { borderColor: colors.border, backgroundColor: colors.background, color: colors.text },
          ]}
          placeholder="Email"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={[
            styles.input,
            { borderColor: colors.border, backgroundColor: colors.background, color: colors.text },
          ]}
          placeholder="Password"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={() => !disabled && submit()}
        />

        {error && <Text style={[styles.error, { color: colors.heart }]}>{error}</Text>}

        <Pressable
          style={[styles.button, { backgroundColor: colors.accent }, disabled && styles.buttonDisabled]}
          disabled={disabled}
          onPress={submit}
        >
          {busy ? (
            <ActivityIndicator color={'#ffffff'} />
          ) : (
            <Text style={[styles.buttonText, { color: '#ffffff' }]}>Log in</Text>
          )}
        </Pressable>

        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: colors.textSecondary }]}>
            Don't have an account?{' '}
          </Text>
          <Pressable onPress={() => router.replace('/(auth)/sign-up')} hitSlop={8}>
            <Text style={[styles.footerLink, { color: colors.accent }]}>Sign up</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-start' },
  card: { paddingHorizontal: 32, marginTop: '18%' },
  wordmark: {
    fontSize: 44,
    textAlign: 'center',
    fontWeight: '300',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  tagline: { textAlign: 'center', fontSize: 14, marginBottom: 36 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    marginBottom: 10,
  },
  button: {
    borderRadius: 4,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontWeight: '600', fontSize: 15 },
  error: { fontSize: 13, marginTop: 4, marginBottom: 4, textAlign: 'center' },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 28 },
  footerText: { fontSize: 13 },
  footerLink: { fontSize: 13, fontWeight: '600' },
});
