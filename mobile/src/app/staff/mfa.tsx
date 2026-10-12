// Two-step verification (ADM-03): enrol an authenticator app the first time, then a 6-digit
// code on every sign-in. Required for Owners and Managers.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Linking, Text, View } from 'react-native';
import { Button, Card, ErrorState, Field, H1, Loading, Muted, Notice, Screen } from '@/components/ui';
import { auth, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/theme';

export default function Mfa() {
  const { loading, session, needsMfa, verifyCode, signOut } = useAuth();
  const enrolled = session?.mfa_enrolled ?? false;
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One secret per user while they set up the app (switching apps must not replace it).
  const enrolment = useQuery({
    queryKey: ['staff', 'mfa-enrol', session?.user.id],
    enabled: Boolean(session && !enrolled),
    queryFn: auth.mfaEnroll,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    if (loading) return;
    if (!session) router.replace('/staff/login');
    else if (!needsMfa) router.replace('/staff');
  }, [loading, session, needsMfa]);

  async function verify() {
    if (!/^\d{6}$/.test(code.trim())) return setError('Enter the 6-digit code from your authenticator app.');
    setBusy(true);
    setError(null);
    try {
      await verifyCode(code.trim()); // the effect above moves on
    } catch (err) {
      setError(errorText(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <Loading />;
  return (
    <Screen>
      <H1>{enrolled ? 'Two-step verification' : 'Set up two-step verification'}</H1>
      {!enrolled && enrolment.isLoading ? <Loading /> : null}
      {!enrolled && enrolment.error ? <ErrorState message={errorText(enrolment.error)} onRetry={() => void enrolment.refetch()} /> : null}
      {!enrolled && enrolment.data ? (
        <Card>
          <Muted>
            Owner and Manager accounts need an authenticator app (Google Authenticator, Microsoft Authenticator or similar). Tap the button to add KSR to the
            app on this phone, or type the key into it, then enter the 6-digit code it shows.
          </Muted>
          <Button
            label="Add to authenticator app"
            variant="dark"
            onPress={() =>
              void Linking.openURL(enrolment.data!.uri).catch(() => setError('No authenticator app found. Install one, or type the key below into it.'))
            }
          />
          <Image source={{ uri: enrolment.data.qr }} accessibilityLabel="QR code for your authenticator app" style={{ width: 200, height: 200, alignSelf: 'center' }} />
          <View style={{ backgroundColor: colors.subtle, borderRadius: 10, padding: 12 }}>
            <Text selectable style={{ fontFamily: 'monospace', fontSize: 16, color: colors.ink, textAlign: 'center' }}>
              {enrolment.data.secret}
            </Text>
          </View>
        </Card>
      ) : null}
      {enrolled ? <Muted>Enter the 6-digit code from your authenticator app.</Muted> : null}
      {enrolled || enrolment.data ? (
        <Card>
          <Field
            label="6-digit code"
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
            autoFocus
            onSubmitEditing={() => void verify()}
          />
          {error ? <Notice>{error}</Notice> : null}
          <Button label="Verify" onPress={() => void verify()} loading={busy} />
        </Card>
      ) : null}
      <Button label="Sign out" variant="ghost" onPress={() => void signOut().then(() => router.replace('/staff/login'))} />
    </Screen>
  );
}
