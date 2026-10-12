// Booking request (BK-*): car, package, pickup day and time, details, consent. Same checks as
// the website (shared/validation.ts) before sending, and the server checks again.
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { computeReturn, packagePrice } from '@shared/booking.ts';
import { formatRupees } from '@shared/money.ts';
import { availableSlots, formatClock, formatWhen, fromIst, istDateIso } from '@shared/time.ts';
import { checkDl, formatPhone, MESSAGES, validateBookingRequest, type BookingField } from '@shared/validation.ts';
import { CarPhoto } from '@/components/CarCard';
import { Button, Card, Checkbox, Chip, ErrorState, Field, H2, Loading, Notice, Plate, Row, Screen } from '@/components/ui';
import { ApiError, errorText, fn } from '@/lib/api';
import { busyKind, busyText, pickupDays } from '@/lib/booking';
import { useBusyWindows, useCars, usePublicConfig } from '@/lib/data';
import { useServer } from '@/lib/server';
import type { Suggestion, SubmitResponse } from '@/lib/types';
import { whatsappUrl } from '@/lib/url';
import { colors, radius, space } from '@/theme';

type Pkg = '12h' | '24h';
const FIELDS: BookingField[] = ['car_id', 'package', 'pickup', 'full_name', 'phone', 'dl_number', 'email', 'consent'];

interface Sent {
  code: string;
  car: string;
  pkg: Pkg;
  pickupAt: Date;
  returnAt: Date;
  price: number;
  phone: string;
}

export default function Book() {
  const params = useLocalSearchParams<{ car?: string; pkg?: string }>();
  const cars = useCars();
  const config = usePublicConfig();
  const { url } = useServer();

  const [carId, setCarId] = useState<string | undefined>(params.car);
  const [pkg, setPkg] = useState<Pkg>(params.pkg === '24h' ? '24h' : '12h');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [dl, setDl] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<BookingField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [clash, setClash] = useState<{ message: string; suggestions: Suggestion[] } | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [now] = useState(() => Date.now());

  const list = useMemo(() => cars.data ?? [], [cars.data]);
  const car = list.find((c) => c.id === carId) ?? list[0];
  useEffect(() => {
    if (!carId && list[0]) setCarId(list[0].id);
  }, [carId, list]);

  const rules = config.data?.rules;
  const hours = config.data?.business.hours;
  const today = istDateIso(now);
  const days = useMemo(() => (rules && hours ? pickupDays(today, rules.window_days, hours) : []), [rules, hours, today]);
  const slots = useMemo(
    () => (date && rules && hours ? availableSlots(date, hours, rules.time_step_minutes, rules.min_lead_hours, now) : []),
    [date, rules, hours, now],
  );
  const effectiveTime = slots.includes(time) ? time : '';
  const pickupAt = date && effectiveTime ? fromIst(date, effectiveTime) : null;
  const returnAt = pickupAt ? computeReturn(pickupAt, pkg) : null;
  const busy = useBusyWindows(
    pickupAt ? pickupAt.toISOString() : null,
    returnAt && rules ? new Date(returnAt.getTime() + rules.turnaround_buffer_minutes * 60_000).toISOString() : null,
  );
  const busyFor = (id: string) => busyText(busyKind(busy.data, id, pickupAt, returnAt, rules?.turnaround_buffer_minutes ?? 0));

  if (cars.isLoading || config.isLoading) return <Loading />;
  if (cars.error || config.error || !car || !rules || !hours) {
    return <ErrorState message={errorText(cars.error ?? config.error ?? new Error('No cars to book right now.'))} onRetry={() => void Promise.all([cars.refetch(), config.refetch()])} />;
  }

  const price = packagePrice(car, pkg);
  const business = config.data!.business;

  async function submit() {
    setFormError(null);
    setClash(null);
    const input = {
      car_id: car!.id,
      package: pkg,
      pickup_date: date,
      pickup_time: effectiveTime,
      full_name: name,
      phone,
      dl_number: dl,
      email,
      consent,
      website: '',
    };
    const v = validateBookingRequest(input, { rules: rules!, hours: hours!, now: Date.now() });
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setSending(true);
    try {
      const res = await fn<SubmitResponse>('submit-booking', { ...input, locale: 'en' });
      if (res.ok) {
        setSent({ code: res.booking_code, car: car!.display_name, pkg, pickupAt: v.value.pickup_at, returnAt: computeReturn(v.value.pickup_at, pkg), price, phone: v.value.phone });
      } else {
        setClash({ message: res.message || MESSAGES.carClash, suggestions: res.suggestions ?? [] });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation' && err.hint && typeof err.hint === 'object') {
        setErrors(err.hint as Partial<Record<BookingField, string>>);
      } else if (err instanceof ApiError && err.code && (FIELDS as string[]).includes(err.code)) {
        setErrors({ [err.code]: err.message });
      } else {
        setFormError(err instanceof ApiError && err.status === 429 ? MESSAGES.tooManyRequests : errorText(err));
      }
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <Screen>
        <Card>
          <Text style={styles.done}>Request sent</Text>
          <Text style={styles.body}>
            Your booking code is <Text style={styles.code}>{sent.code}</Text>. We&apos;ll call you on {formatPhone(sent.phone)} to confirm.
          </Text>
          <View style={styles.night}>
            <Plate big>{formatRupees(sent.price)}</Plate>
            <Row dark label="Car" value={sent.car} />
            <Row dark label="Package" value={sent.pkg === '12h' ? '12 hrs' : '24 hrs'} />
            <Row dark label="Pickup" value={formatWhen(sent.pickupAt)} />
            <Row dark label="Return by" value={formatWhen(sent.returnAt)} />
          </View>
          <H2>What to bring</H2>
          <Text style={styles.body}>Your original driving licence and Aadhaar (or passport/voter ID). We&apos;ll verify them at pickup and hand you the keys.</Text>
          {business.phone ? <Button label="Call us" onPress={() => void Linking.openURL(`tel:${business.phone}`)} /> : null}
          {business.whatsapp ? <Button label="WhatsApp us" variant="secondary" onPress={() => void Linking.openURL(whatsappUrl(business.whatsapp, `Booking ${sent.code}`))} /> : null}
          <Button label="Done" variant="secondary" onPress={() => router.dismissTo('/')} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <H2>Car</H2>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {list.map((c) => {
            const on = c.id === car.id;
            const note = busyFor(c.id);
            return (
              <Pressable
                key={c.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${c.display_name}, from ${formatRupees(c.price_12h_paise)}${note ? `, ${note}` : ''}`}
                onPress={() => {
                  setCarId(c.id);
                  setClash(null);
                }}
                style={[styles.carChip, on && styles.carChipOn]}
              >
                <Text style={styles.carChipName}>{c.display_name}</Text>
                <Text style={styles.carChipPrice}>from {formatRupees(c.price_12h_paise)}</Text>
                {note ? <Text style={styles.busy}>{note}</Text> : null}
              </Pressable>
            );
          })}
        </ScrollView>
        <CarPhoto car={car} height={130} />
        {busyFor(car.id) ? <Text style={styles.busy}>{busyFor(car.id)}</Text> : null}
      </Card>

      <Card>
        <H2>Package</H2>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {(['12h', '24h'] as const).map((p) => (
            <Pressable
              key={p}
              accessibilityRole="radio"
              accessibilityState={{ selected: pkg === p }}
              onPress={() => setPkg(p)}
              style={[styles.pkg, pkg === p && styles.pkgOn]}
            >
              <Text style={styles.pkgTitle}>{p === '12h' ? '12 hrs' : '24 hrs'}</Text>
              <Text style={styles.pkgPrice}>{formatRupees(packagePrice(car, p))}</Text>
            </Pressable>
          ))}
        </View>
      </Card>

      <Card>
        <H2>Pickup</H2>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {days.map((d) => (
            <Chip key={d.date} label={d.label} note={d.closed ? 'Closed' : d.sub} selected={date === d.date} disabled={d.closed} onPress={() => setDate(d.date)} />
          ))}
        </ScrollView>
        {date ? (
          slots.length ? (
            <View style={styles.slots}>
              {slots.map((t) => (
                <Chip key={t} label={formatClock(t)} selected={effectiveTime === t} onPress={() => setTime(t)} />
              ))}
            </View>
          ) : (
            <Text style={styles.error}>{date === today ? MESSAGES.pickupTooSoon(rules.min_lead_hours) : 'No pickup times on this date. Choose another date.'}</Text>
          )
        ) : (
          <Text style={styles.hint}>
            Choose a day, then a time. Pickups need at least {rules.min_lead_hours} hours&apos; notice.
          </Text>
        )}
        {errors.pickup ? <Text style={styles.error}>{errors.pickup}</Text> : null}
        <Row label="Return by" value={returnAt ? formatWhen(returnAt) : 'Set by your pickup time'} />
      </Card>

      <Card>
        <H2>Your details</H2>
        <Field label="Full name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" maxLength={80} error={errors.full_name} />
        <Field label="Mobile number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" placeholder="98765 43210" error={errors.phone} />
        <Field
          label="Driving licence number"
          value={dl}
          onChangeText={setDl}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={24}
          placeholder="TS0920110012345"
          error={errors.dl_number}
          hint={dl && !checkDl(dl).error && checkDl(dl).oldFormat ? MESSAGES.dlOldFormat : 'As printed on your licence.'}
        />
        <Field label="Email" optional value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" error={errors.email} />
        <Checkbox checked={consent} onChange={setConsent} error={errors.consent}>
          <Text style={styles.body}>
            I agree that KSR Self Drive Cars can use my name, mobile number and driving licence details to process this booking, verify my identity at pickup,
            and handle any fines or damage linked to this rental.{' '}
            <Text style={styles.link} onPress={() => void WebBrowser.openBrowserAsync(`${url}/privacy`)}>
              Read the privacy notice
            </Text>
          </Text>
        </Checkbox>
      </Card>

      {clash ? (
        <Notice title={clash.message}>
          {clash.suggestions.length ? (
            <View style={{ gap: space.sm, marginTop: 4 }}>
              <Text style={{ color: colors.danger }}>These cars are free at that time:</Text>
              {clash.suggestions.map((s) => (
                <Button
                  key={s.id}
                  small
                  variant="secondary"
                  label={`${s.display_name} · ${formatRupees(pkg === '12h' ? s.price_12h_paise : s.price_24h_paise)}`}
                  onPress={() => {
                    setCarId(s.id);
                    setClash(null);
                  }}
                />
              ))}
            </View>
          ) : null}
        </Notice>
      ) : null}
      {formError ? <Notice>{formError}</Notice> : null}
      {Object.keys(errors).length > 0 ? <Notice tone="amber">Check the highlighted fields above.</Notice> : null}

      <View style={styles.summary}>
        <View>
          <Text style={styles.summaryLabel}>Total</Text>
          <Plate big>{formatRupees(price)}</Plate>
        </View>
        <Button label="Request booking" onPress={() => void submit()} loading={sending} style={{ flex: 1 }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  carChip: { width: 150, borderRadius: radius.md, borderWidth: 2, borderColor: colors.lineCard, backgroundColor: colors.subtle, padding: space.md, gap: 2 },
  carChipOn: { borderColor: colors.ink, backgroundColor: '#fff' },
  carChipName: { fontWeight: '800', fontSize: 15, color: colors.ink },
  carChipPrice: { fontSize: 13, color: colors.muted },
  busy: { color: colors.danger, fontWeight: '700', fontSize: 13 },
  pkg: { flex: 1, minHeight: 64, borderRadius: radius.md, borderWidth: 2, borderColor: colors.lineCard, padding: space.md, justifyContent: 'center' },
  pkgOn: { borderColor: colors.ink, backgroundColor: colors.subtle },
  pkgTitle: { fontWeight: '800', fontSize: 17, color: colors.ink },
  pkgPrice: { fontSize: 15, color: colors.muted },
  slots: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  hint: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontWeight: '700', fontSize: 14 },
  body: { color: colors.ink2, fontSize: 15, lineHeight: 21 },
  link: { color: colors.action, textDecorationLine: 'underline', fontWeight: '700' },
  summary: { flexDirection: 'row', alignItems: 'flex-end', gap: space.lg, backgroundColor: '#fff', borderRadius: radius.lg, padding: space.lg, borderWidth: 1, borderColor: colors.lineCard },
  summaryLabel: { color: colors.muted, fontSize: 13, marginBottom: 4 },
  done: { fontSize: 34, fontWeight: '900', color: colors.ink },
  code: { fontWeight: '900', fontFamily: 'monospace' },
  night: { backgroundColor: colors.ink, borderRadius: radius.lg, padding: space.lg, gap: 4 },
});
