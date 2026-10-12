// Booking lookup (5.5): booking code + mobile number → status and pickup details.
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatWhen } from '@shared/time.ts';
import { validatePhone } from '@shared/validation.ts';
import { Button, Card, Field, H1, Muted, Notice, Row, Screen } from '@/components/ui';
import { errorText, rpc } from '@/lib/api';
import type { LookupResult } from '@/lib/types';
import { colors, radius, space } from '@/theme';

export default function Status() {
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<{ code?: string; phone?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);

  async function check() {
    const e: typeof errors = {};
    if (!code.trim()) e.code = 'Enter the booking code from your confirmation, for example KSR-261012-001.';
    const phoneError = validatePhone(phone);
    if (phoneError) e.phone = phoneError;
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await rpc<LookupResult>('lookup_booking', { p_code: code.trim().toUpperCase(), p_phone: phone }));
    } catch (err) {
      setErrors({ form: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <H1>Check a booking</H1>
      <Muted>Enter the code from your confirmation and the mobile number you booked with.</Muted>
      <Card>
        <Field label="Booking code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="KSR-261012-001" error={errors.code} />
        <Field label="Mobile number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" error={errors.phone} />
        {errors.form ? <Notice>{errors.form}</Notice> : null}
        <Button label="Check status" onPress={() => void check()} loading={busy} />
      </Card>

      {result && !result.found ? <Notice tone="blue">We couldn&apos;t find a booking with that code and mobile number.</Notice> : null}
      {result?.found ? (
        <View style={styles.result} accessibilityLiveRegion="polite">
          <Text style={styles.code}>{result.code}</Text>
          <Text style={styles.status}>{result.status}</Text>
          <Row dark label="Car" value={result.car ?? ''} />
          <Row dark label="Package" value={result.package ?? ''} />
          <Row dark label="Pickup" value={result.pickup_at ? formatWhen(result.pickup_at) : ''} />
          <Row dark label="Return by" value={result.return_due_at ? formatWhen(result.return_due_at) : ''} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  result: { backgroundColor: colors.ink, borderRadius: radius.lg, padding: space.lg, gap: 4 },
  code: { color: colors.nightText, fontFamily: 'monospace', fontSize: 17, fontWeight: '700' },
  status: { color: colors.plate, fontSize: 38, fontWeight: '900', marginBottom: space.sm },
});
