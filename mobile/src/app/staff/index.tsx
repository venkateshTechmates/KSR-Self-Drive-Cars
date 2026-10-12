// Staff dashboard (DSH-01/02/03): requests to act on (Owner/Manager), today's pickups and
// returns, and overdue cars. Everything else is in Bookings or the full admin.
import { router, Stack } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { ROLE_LABELS } from '@shared/constants.ts';
import { formatDuration, formatRelativeDay, formatWhen } from '@shared/time.ts';
import { BookingRow } from '@/components/BookingRow';
import { Button, Card, ErrorState, H2, Loading, Muted, Pill, Screen } from '@/components/ui';
import { errorText } from '@/lib/api';
import { isOwnerOrManager, useAuth } from '@/lib/auth';
import { useDashboard } from '@/lib/data';
import type { Booking } from '@/lib/types';
import { useStaffGate } from '@/lib/useStaffGate';
import { colors } from '@/theme';

function Section({ title, rows, empty, detail, count }: { title: string; rows: Booking[]; empty: string; detail: (b: Booking) => string; count?: boolean }) {
  return (
    <Card>
      <H2 right={count ? <Pill label={String(rows.length)} tone={rows.length ? 'amber' : 'grey'} /> : undefined}>{title}</H2>
      {rows.length === 0 ? <Muted>{empty}</Muted> : rows.map((b) => <BookingRow key={b.id} booking={b} detail={detail(b)} />)}
    </Card>
  );
}

export default function Dashboard() {
  const { ready, role } = useStaffGate();
  const { session, signOut } = useAuth();
  const om = isOwnerOrManager(role);
  const data = useDashboard(ready, om);

  if (!ready) return <Loading />;
  if (!role) {
    return (
      <Screen>
        <ErrorState message="This account has no admin access. Ask the Owner to check it in Staff." />
        <Button label="Sign out" variant="secondary" onPress={() => void signOut().then(() => router.replace('/staff/login'))} />
      </Screen>
    );
  }
  const now = Date.now();

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void signOut().then(() => router.replace('/'))}>
              <Text style={{ color: colors.plate, fontWeight: '800', fontSize: 15 }}>Sign out</Text>
            </Pressable>
          ),
        }}
      />
      <Screen refreshing={data.isRefetching} onRefresh={() => void data.refetch()}>
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 24, fontWeight: '900', color: colors.ink }}>Hello{session?.access.full_name ? `, ${session.access.full_name}` : ''}</Text>
          <Muted>{ROLE_LABELS[role]} · {formatWhen(now)}</Muted>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button label="All bookings" variant="dark" small onPress={() => router.push('/staff/bookings')} style={{ flex: 1 }} />
          <Button label="Full admin" variant="secondary" small onPress={() => router.push('/staff/admin')} style={{ flex: 1 }} />
        </View>

        {data.isLoading ? (
          <Loading />
        ) : data.error ? (
          <ErrorState message={errorText(data.error)} onRetry={() => void data.refetch()} />
        ) : data.data ? (
          <>
            {om ? (
              <Section
                title="New requests"
                count
                rows={data.data.requested}
                empty="No new requests."
                detail={(b) => `Pickup ${formatRelativeDay(b.pickup_at, now)} · waiting ${formatDuration(now - Date.parse(b.created_at))}`}
              />
            ) : null}
            <Section title="Pickups today" rows={data.data.pickups} empty="No pickups today." detail={(b) => formatWhen(b.pickup_at)} />
            <Section title="Returns today" rows={data.data.returns} empty="No returns today." detail={(b) => `Due ${formatWhen(b.return_due_at)}`} />
            <Section
              title="Overdue"
              count
              rows={data.data.overdue}
              empty="No cars are overdue."
              detail={(b) => `${formatDuration(now - Date.parse(b.return_due_at))} late · was due ${formatRelativeDay(b.return_due_at, now)}`}
            />
          </>
        ) : null}
      </Screen>
    </>
  );
}
