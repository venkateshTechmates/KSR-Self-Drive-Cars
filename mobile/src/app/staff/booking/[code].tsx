// One booking: details, the customer, money, payments and the status actions this role may
// take (Section 7). Handover and return (photos, signature, checklist) open in the full admin.
import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { allowedTransitions, type Transition } from '@shared/booking.ts';
import {
  FLAG_LABELS,
  PACKAGE_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_TYPE_LABELS,
  SOURCE_LABELS,
  type PaymentMethod,
  type PaymentType,
} from '@shared/constants.ts';
import { formatRupees, paiseToInput, parseRupees } from '@shared/money.ts';
import { formatDateTime, formatWhen } from '@shared/time.ts';
import { formatPhone } from '@shared/validation.ts';
import { StatusPill } from '@/components/BookingRow';
import { Button, Card, Chip, ErrorState, Field, H2, Loading, Muted, Notice, Pill, Row, Screen } from '@/components/ui';
import { errorText, rpc } from '@/lib/api';
import { isOwnerOrManager } from '@/lib/auth';
import { useBooking, usePayments } from '@/lib/data';
import type { Booking } from '@/lib/types';
import { whatsappUrl } from '@/lib/url';
import { useStaffGate } from '@/lib/useStaffGate';
import { colors, radius, space } from '@/theme';

type Dialog = null | { kind: 'reason'; t: Transition } | { kind: 'payment' };

export default function BookingDetail() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { ready, role } = useStaffGate();
  const booking = useBooking(ready ? code : undefined);
  const payments = usePayments(booking.data?.id);
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [working, setWorking] = useState<string | null>(null);

  if (!ready || booking.isLoading) return <Loading />;
  if (booking.error) return <ErrorState message={errorText(booking.error)} onRetry={() => void booking.refetch()} />;
  const b = booking.data;
  if (!b) return <ErrorState message={`Booking ${code} not found, or not open to you.`} />;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['staff'] });
  const balance = b.total_paise - b.paid_paise;
  const depositHeld = b.deposit_received_paise - b.deposit_refunded_paise;
  const om = isOwnerOrManager(role);
  const openAdmin = () => router.push({ pathname: '/staff/admin', params: { path: `/admin/bookings/${b.booking_code}` } });

  async function move(to: string, note: string | null, done: string) {
    setWorking(to);
    try {
      await rpc('booking_transition', { p_booking: b!.id, p_to: to, p_note: note, p_override_reason: null });
      await refresh();
      Alert.alert(done);
    } catch (err) {
      // Clashes name the other booking; expired papers need the Owner's override in the full admin.
      Alert.alert("Couldn't update the booking", errorText(err));
    } finally {
      setWorking(null);
    }
  }

  function act(t: Transition) {
    switch (t.action) {
      case 'confirm':
        return void move('confirmed', null, 'Booking confirmed');
      case 'pickup':
      case 'return':
        return Alert.alert(t.label, 'The handover checklist (odometer, fuel, photos and signature) opens in the full admin.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open', onPress: openAdmin },
        ]);
      case 'no_show':
        if (Date.now() < Date.parse(b!.pickup_at)) return Alert.alert('Not yet', `No-show can be marked after the pickup time, ${formatWhen(b!.pickup_at)}.`);
        return Alert.alert('Mark as no-show?', 'The car is released for other bookings.', [
          { text: 'Back', style: 'cancel' },
          { text: 'Mark no-show', style: 'destructive', onPress: () => void move('no_show', null, 'Marked as no-show') },
        ]);
      case 'close':
        if (balance !== 0 || depositHeld !== 0) {
          return Alert.alert('Not settled yet', `Balance ${formatRupees(balance)}, deposit held ${formatRupees(depositHeld)}. Record the payments first, or close it in the full admin with a reason.`);
        }
        return void move('closed', null, 'Booking closed');
      default:
        return setDialog({ kind: 'reason', t });
    }
  }

  const transitions = allowedTransitions(b.status, role);

  return (
    <>
      <Stack.Screen options={{ title: b.booking_code }} />
      <Screen refreshing={booking.isRefetching} onRefresh={() => void Promise.all([booking.refetch(), payments.refetch()])}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={styles.code}>{b.booking_code}</Text>
            <StatusPill booking={b} />
            {b.flags.map((f) => (
              <Pill key={f} label={FLAG_LABELS[f] ?? f} tone="red" />
            ))}
          </View>
          <Text style={styles.title}>
            {b.car?.display_name ?? 'Car'} · {b.package === 'custom' && b.custom_hours ? `${b.custom_hours} hrs` : PACKAGE_LABELS[b.package]}
          </Text>
          <Row label="Pickup" value={formatWhen(b.pickup_at)} />
          <Row label="Return by" value={formatWhen(b.return_due_at)} />
          <Row label="Source" value={`${SOURCE_LABELS[b.source]} · ${formatDateTime(b.created_at)}`} />
          {b.cancel_reason ? <Notice tone="blue" title="Reason">{b.cancel_reason}</Notice> : null}
        </Card>

        {transitions.length ? (
          <Card>
            <H2>Actions</H2>
            {transitions.map((t) => (
              <Button
                key={t.action}
                label={t.action === 'cancel' ? 'Cancel booking' : t.action === 'close' ? 'Close booking' : t.label}
                variant={t.action === 'reject' || t.action === 'cancel' || t.action === 'no_show' ? 'secondary' : 'primary'}
                loading={working === t.to}
                onPress={() => act(t)}
              />
            ))}
          </Card>
        ) : null}

        <Card>
          <H2>Customer</H2>
          {b.customer ? (
            <>
              <Text style={styles.name}>{b.customer.full_name}</Text>
              <Muted>{formatPhone(b.customer.phone)}</Muted>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label="Call" small onPress={() => void Linking.openURL(`tel:${b.customer!.phone}`)} style={{ flex: 1 }} />
                <Button
                  label="WhatsApp"
                  small
                  variant="secondary"
                  onPress={() => void Linking.openURL(whatsappUrl(b.customer!.phone, `Hi ${b.customer!.full_name}, about your KSR booking ${b.booking_code}.`))}
                  style={{ flex: 1 }}
                />
              </View>
            </>
          ) : (
            <Muted>Customer details show on the day of the booking.</Muted>
          )}
        </Card>

        <Card>
          <H2 right={<Pill label={PAYMENT_STATUS_LABELS[b.payment_status]} tone={b.payment_status === 'paid' ? 'green' : b.payment_status === 'part_paid' ? 'blue' : 'amber'} />}>
            Money
          </H2>
          <Row label="Total" value={formatRupees(b.total_paise)} strong />
          <Row label="Paid" value={formatRupees(b.paid_paise)} />
          <Row label={balance < 0 ? 'Overpaid' : 'Balance'} value={formatRupees(Math.abs(balance))} strong />
          <Row label="Deposit held" value={`${formatRupees(depositHeld)} of ${formatRupees(b.deposit_paise)}`} />
          <H2>Payments</H2>
          {payments.isLoading ? (
            <Muted>Loading payments…</Muted>
          ) : (payments.data ?? []).length === 0 ? (
            <Muted>No payments yet.</Muted>
          ) : (
            payments.data!.map((p) => (
              <Row
                key={p.id}
                label={`${PAYMENT_TYPE_LABELS[p.type]} · ${PAYMENT_METHOD_LABELS[p.method]}${p.reference ? ` · ${p.reference}` : ''}`}
                value={`${p.type === 'refund' || p.type === 'deposit_refund' ? '− ' : ''}${formatRupees(p.amount_paise)}`}
              />
            ))
          )}
          <Button label="Record payment" variant="dark" onPress={() => setDialog({ kind: 'payment' })} />
        </Card>

        <Button label="Open in full admin" variant="secondary" onPress={openAdmin} />
      </Screen>

      <ReasonSheet
        transition={dialog?.kind === 'reason' ? dialog.t : null}
        booking={b}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          const t = (dialog as { t: Transition }).t;
          await rpc('booking_transition', { p_booking: b.id, p_to: t.to, p_note: reason, p_override_reason: null });
          await refresh();
        }}
      />
      <PaymentSheet open={dialog?.kind === 'payment'} booking={b} canRefund={om} onClose={() => setDialog(null)} onSaved={refresh} />
    </>
  );
}

function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: space.lg + insets.bottom }]}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.md }}>
          <Text style={styles.sheetTitle} accessibilityRole="header">
            {title}
          </Text>
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

function ReasonSheet({
  transition,
  booking,
  onClose,
  onSubmit,
}: {
  transition: Transition | null;
  booking: Booking;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verb = transition?.action === 'reject' ? 'Reject' : 'Cancel';
  async function submit() {
    if (!reason.trim()) return setError('Give a reason.');
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setReason('');
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open={Boolean(transition)} title={`${verb} ${booking.booking_code}?`} onClose={onClose}>
      <Muted>
        {transition?.action === 'reject'
          ? 'The customer is not told automatically. Send them a message after this.'
          : 'The car is released for other bookings.'}
      </Muted>
      <Field label="Reason" value={reason} onChangeText={setReason} multiline error={error} hint="For example: car not available, licence not valid." />
      <Button label={`${verb} booking`} variant="danger" loading={busy} onPress={() => void submit()} />
      <Button label="Back" variant="ghost" onPress={onClose} />
    </Sheet>
  );
}

function PaymentSheet({ open, booking, canRefund, onClose, onSaved }: { open: boolean; booking: Booking; canRefund: boolean; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const balance = booking.total_paise - booking.paid_paise;
  const depositHeld = booking.deposit_received_paise - booking.deposit_refunded_paise;
  const types: PaymentType[] = ['rent', 'deposit', 'extra', ...(canRefund ? (['refund', 'deposit_refund'] as const) : [])];
  const suggested = (t: PaymentType) =>
    t === 'rent' ? Math.max(balance, 0) : t === 'deposit' ? Math.max(booking.deposit_paise - depositHeld, 0) : t === 'deposit_refund' ? depositHeld : 0;
  const [type, setType] = useState<PaymentType>(balance > 0 ? 'rent' : 'deposit');
  const [amount, setAmount] = useState(paiseToInput(suggested(balance > 0 ? 'rent' : 'deposit')) || '');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const refund = type === 'refund' || type === 'deposit_refund';

  async function save() {
    const e: Record<string, string> = {};
    const paise = parseRupees(amount);
    if (paise === null || paise <= 0) e.amount = 'Enter an amount above zero, for example 1800.';
    if (refund && !note.trim()) e.note = 'Give a reason for the refund.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await rpc('record_payment', {
        p_booking: booking.id,
        p_amount_paise: paise,
        p_type: type,
        p_method: method,
        p_reference: reference.trim() || null,
        p_note: note.trim(),
        p_receipt_document_id: null,
        p_received_at: null,
      });
      await onSaved();
      onClose();
      Alert.alert('Payment recorded', `${PAYMENT_TYPE_LABELS[type]} of ${formatRupees(paise!)}`);
      setReference('');
      setNote('');
    } catch (err) {
      setErrors({ form: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} title="Record payment" onClose={onClose}>
      <Muted>
        {booking.booking_code} · total {formatRupees(booking.total_paise)} · balance {formatRupees(balance)}
      </Muted>
      <View style={styles.wrap}>
        {types.map((t) => (
          <Chip
            key={t}
            label={PAYMENT_TYPE_LABELS[t]}
            selected={type === t}
            onPress={() => {
              setType(t);
              setAmount(paiseToInput(suggested(t)) || '');
            }}
          />
        ))}
      </View>
      <Field label="Amount (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" error={errors.amount} />
      <View style={styles.wrap}>
        {PAYMENT_METHODS.map((m) => (
          <Chip key={m} label={PAYMENT_METHOD_LABELS[m]} selected={method === m} onPress={() => setMethod(m)} />
        ))}
      </View>
      <Field label="Reference" optional value={reference} onChangeText={setReference} hint="UPI, card or bank reference number." autoCapitalize="characters" />
      <Field label={refund ? 'Reason for the refund' : 'Note'} optional={!refund} value={note} onChangeText={setNote} error={errors.note} />
      {errors.form ? <Notice>{errors.form}</Notice> : null}
      <Button label={refund ? 'Record refund' : 'Record payment'} loading={busy} onPress={() => void save()} />
      <Button label="Cancel" variant="ghost" onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  code: { fontFamily: 'monospace', fontWeight: '900', fontSize: 18, color: colors.ink },
  title: { fontSize: 20, fontWeight: '800', color: colors.ink },
  name: { fontSize: 18, fontWeight: '800', color: colors.ink },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(29,33,37,0.5)' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, maxHeight: '85%' },
  sheetTitle: { fontSize: 22, fontWeight: '900', color: colors.ink },
});
