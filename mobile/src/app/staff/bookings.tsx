// Bookings: search by code, customer, mobile or car; filter by status. Staff see the window
// the server allows them (yesterday to tomorrow, and cars out now).
import { useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { BOOKING_STATUS_LABELS, type BookingStatus } from '@shared/constants.ts';
import { formatWhen } from '@shared/time.ts';
import { BookingRow } from '@/components/BookingRow';
import { Card, Chip, ErrorState, Loading, Muted, Screen, styles as ui } from '@/components/ui';
import { errorText } from '@/lib/api';
import { useRecentBookings } from '@/lib/data';
import { useStaffGate } from '@/lib/useStaffGate';

const STATUSES: Array<BookingStatus | 'all'> = ['all', 'requested', 'confirmed', 'active', 'returned', 'closed', 'rejected', 'cancelled'];

export default function Bookings() {
  const { ready, role } = useStaffGate();
  const list = useRecentBookings(ready);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<BookingStatus | 'all'>('all');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s+/g, '');
    return (list.data ?? []).filter((b) => {
      if (status !== 'all' && b.status !== status) return false;
      if (!needle) return true;
      const hay = [b.booking_code, b.customer?.full_name, b.customer?.phone, b.car?.display_name, b.car?.registration_number]
        .filter(Boolean)
        .join('|')
        .toLowerCase()
        .replace(/\s+/g, '');
      return hay.includes(needle);
    });
  }, [list.data, q, status]);

  if (!ready) return <Loading />;
  return (
    <Screen refreshing={list.isRefetching} onRefresh={() => void list.refetch()}>
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Booking code, customer, mobile or car"
        accessibilityLabel="Search bookings"
        autoCorrect={false}
        style={ui.input}
        placeholderTextColor="#8a918b"
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {STATUSES.map((s) => (
          <Chip key={s} label={s === 'all' ? 'All' : BOOKING_STATUS_LABELS[s]} selected={status === s} onPress={() => setStatus(s)} />
        ))}
      </ScrollView>
      {role === 'staff' ? <Muted>You can see bookings from yesterday to tomorrow, and cars that are out now.</Muted> : null}
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorState message={errorText(list.error)} onRetry={() => void list.refetch()} />
      ) : (
        <Card style={{ paddingVertical: 4 }}>
          {rows.length === 0 ? (
            <View style={{ paddingVertical: 12 }}>
              <Muted>No bookings match.</Muted>
            </View>
          ) : (
            rows.map((b) => <BookingRow key={b.id} booking={b} detail={`Pickup ${formatWhen(b.pickup_at)}`} />)
          )}
        </Card>
      )}
    </Screen>
  );
}
