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

const USERNAME_RE = /^[a-z0-9._]{3,30}$/;

export default function SignUp() {
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const normalizedUsername = username.trim().toLowerCase();
  const usernameValid = USERNAME_RE.test(normalizedUsername);
  const disabled = busy || !email.trim() || !usernameValid || password.length < 6;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signUp(email.trim(), password, normalizedUsername);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create that account.');
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

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#8e8e8e"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Username"
          placeholderTextColor="#8e8e8e"
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
        />
        {username.length > 0 && !usernameValid && (
          <Text style={styles.hint}>
            3–30 characters, lowercase letters, numbers, dots and underscores only.
          </Text>
        )}
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#8e8e8e"
          autoCapitalize="none"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        {password.length > 0 && password.length < 6 && (
          <Text style={styles.hint}>At least 6 characters.</Text>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.button, disabled && styles.buttonDisabled]}
          disabled={disabled}
          onPress={submit}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign up</Text>}
        </Pressable>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <Link href="/(auth)/sign-in" style={styles.footerLink}>
            Log in
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
    marginBottom: 32,
  },
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
  hint: { color: '#8e8e8e', fontSize: 12, marginTop: -4, marginBottom: 10, paddingHorizontal: 2 },
  button: {
    backgroundColor: '#3897f0',
    borderRadius: 4,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  error: { color: '#ed4956', fontSize: 13, marginVertical: 4, textAlign: 'center' },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 28 },
  footerText: { color: '#8e8e8e', fontSize: 13 },
  footerLink: { color: '#3897f0', fontSize: 13, fontWeight: '600' },
});
