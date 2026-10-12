// Settings: which KSR server the app talks to (the live site by default; a computer on the
// office Wi-Fi while testing), and the app version.
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Card, Field, H1, Muted, Notice, Row, Screen, Button } from '@/components/ui';
import { checkServer } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { DEFAULT_SERVER_URL, useServer } from '@/lib/server';
import { normalizeServerUrl } from '@/lib/url';

export default function Settings() {
  const { url, isDefault, setUrl } = useServer();
  const { refresh } = useAuth();
  const [value, setValue] = useState(url);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: string | null) {
    setError(null);
    const target = next === null ? DEFAULT_SERVER_URL : normalizeServerUrl(next);
    if (!target) return setError('Enter an address like https://ksr-self-drive-cars.onrender.com or 192.168.0.6:3000.');
    setBusy(true);
    try {
      if (!(await checkServer(target))) {
        return setError(`No KSR server answered at ${target}. Check the address and that the phone can reach it.`);
      }
      await setUrl(next === null ? null : target);
      await refresh();
      router.dismissTo('/');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <H1>Settings</H1>
      <Card>
        <Field
          label="Server address"
          value={value}
          onChangeText={setValue}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          error={error}
          hint={`Default: ${DEFAULT_SERVER_URL}`}
        />
        <Button label="Save" loading={busy} onPress={() => void save(value)} />
        {!isDefault ? <Button label="Use the default" variant="secondary" onPress={() => void save(null)} /> : null}
        <Notice tone="blue">Changing the server signs staff out of the app.</Notice>
      </Card>
      <Card>
        <Row label="App version" value={Constants.expoConfig?.version ?? '1.0.0'} />
        <Row label="Using" value={url} />
      </Card>
      <Muted>KSR Self Drive Cars · bookings, staff dashboard and full admin.</Muted>
    </Screen>
  );
}
