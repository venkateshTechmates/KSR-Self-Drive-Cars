import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { displayStatus, type DisplayStatus } from '@shared/booking.ts';
import { BOOKING_STATUS_LABELS, type BookingStatus } from '@shared/constants.ts';
import type { Booking } from '@/lib/types';
import { colors, space } from '@/theme';
import { Pill } from './ui';

const TONE: Record<DisplayStatus, 'amber' | 'blue' | 'green' | 'red' | 'grey' | 'dark'> = {
  requested: 'amber',
  confirmed: 'blue',
  active: 'green',
  overdue: 'red',
  returned: 'dark',
  closed: 'grey',
  rejected: 'grey',
  cancelled: 'grey',
  no_show: 'grey',
};

export function StatusPill({ booking }: { booking: Pick<Booking, 'status' | 'return_due_at'> }) {
  const s = displayStatus(booking);
  return <Pill label={s === 'overdue' ? 'Overdue' : BOOKING_STATUS_LABELS[s as BookingStatus]} tone={TONE[s]} />;
}

export function BookingRow({ booking, detail }: { booking: Booking; detail?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Booking ${booking.booking_code}, ${booking.car?.display_name ?? 'car'}, ${booking.customer?.full_name ?? ''}`}
      onPress={() => router.push({ pathname: '/staff/booking/[code]', params: { code: booking.booking_code } })}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}
    >
      <View style={styles.top}>
        <Text style={styles.code}>{booking.booking_code}</Text>
        <StatusPill booking={booking} />
      </View>
      <Text style={styles.line} numberOfLines={1}>
        {booking.car?.display_name ?? 'Car'}
        {booking.customer ? ` · ${booking.customer.full_name}` : ''}
      </Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: space.md, paddingHorizontal: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, gap: 2, minHeight: 56 },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  code: { fontFamily: 'monospace', fontWeight: '800', fontSize: 15, color: colors.ink },
  line: { fontSize: 15, color: colors.ink2 },
  detail: { fontSize: 13, color: colors.muted },
});
