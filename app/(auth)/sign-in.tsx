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
import { Link } from 'expo-router';
import { useAuth } from '../../lib/auth';

export default function SignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.wordmark}>Kalos</Text>
        <Text style={styles.tagline}>Photos from people you actually follow.</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#8e8e8e"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#8e8e8e"
          autoCapitalize="none"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={() => !disabled && submit()}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.button, disabled && styles.buttonDisabled]}
          disabled={disabled}
          onPress={submit}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Log in</Text>}
        </Pressable>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Don't have an account? </Text>
          <Link href="/(auth)/sign-up" style={styles.footerLink}>
            Sign up
          </Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff', justifyContent: 'center' },
  card: { paddingHorizontal: 32 },
  wordmark: {
    fontSize: 44,
    textAlign: 'center',
    color: '#262626',
    fontWeight: '300',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  tagline: { textAlign: 'center', color: '#8e8e8e', fontSize: 14, marginBottom: 36 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#dbdbdb',
    backgroundColor: '#fafafa',
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: '#262626',
    marginBottom: 10,
  },
  button: {
    backgroundColor: '#3897f0',
    borderRadius: 4,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  error: { color: '#ed4956', fontSize: 13, marginTop: 4, marginBottom: 4, textAlign: 'center' },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 28 },
  footerText: { color: '#8e8e8e', fontSize: 13 },
  footerLink: { color: '#3897f0', fontSize: 13, fontWeight: '600' },
});
