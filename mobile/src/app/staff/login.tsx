// Staff sign-in (ADM-02). Owners and Managers continue to two-step verification.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { Button, Card, Field, H1, Muted, Notice, Screen } from '@/components/ui';
import { errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useServer } from '@/lib/server';
import { colors } from '@/theme';

export default function Login() {
  const { session, needsMfa, signIn, loading } = useAuth();
  const { url } = useServer();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && session) router.replace(needsMfa ? '/staff/mfa' : '/staff');
  }, [loading, session, needsMfa]);

  async function submit() {
    setError(null);
    if (!email.trim() || !password) return setError('Enter your email and password.');
    setBusy(true);
    try {
      await signIn(email, password); // the effect above moves on
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <H1>Staff sign-in</H1>
      <Muted>For KSR staff. Customers don&apos;t need an account to book.</Muted>
      <Card>
        <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="username" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" onSubmitEditing={() => void submit()} />
        {error ? <Notice>{error}</Notice> : null}
        <Button label="Sign in" onPress={() => void submit()} loading={busy} />
      </Card>
      <Pressable accessibilityRole="link" onPress={() => router.push('/settings')} hitSlop={8}>
        <Text style={{ color: colors.muted, fontSize: 14 }}>
          Server: {url} · <Text style={{ color: colors.action, textDecorationLine: 'underline' }}>Change</Text>
        </Text>
      </Pressable>
    </Screen>
  );
}
