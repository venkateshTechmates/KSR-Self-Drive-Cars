// Home: the fleet with 12/24 hr prices and filters (the website's home page, as an app screen).
import { router, Stack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatRupees } from '@shared/money.ts';
import { CarCard } from '@/components/CarCard';
import { Button, Chip, ErrorState, Loading, Muted, Screen } from '@/components/ui';
import { errorText } from '@/lib/api';
import { useCars, usePublicConfig } from '@/lib/data';
import { useServer } from '@/lib/server';
import type { PublicCar } from '@/lib/types';
import { whatsappUrl } from '@/lib/url';
import { colors, radius, space } from '@/theme';

type Filter = 'all' | 'hatch' | 'suv' | 'mpv' | 'cng';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'hatch', label: 'Hatchbacks' },
  { id: 'suv', label: 'SUVs' },
  { id: 'mpv', label: '6–7 seaters' },
  { id: 'cng', label: 'CNG' },
];
const inFilter = (c: PublicCar, f: Filter) => (f === 'all' ? true : f === 'cng' ? c.fuel === 'cng' : c.category === f);

export default function Home() {
  const cars = useCars();
  const config = usePublicConfig();
  const { url } = useServer();
  const [pkg, setPkg] = useState<'12h' | '24h'>('12h');
  const [filter, setFilter] = useState<Filter>('all');

  const list = useMemo(() => cars.data ?? [], [cars.data]);
  const shown = list.filter((c) => inFilter(c, filter));
  const from = list.length ? Math.min(...list.map((c) => c.price_12h_paise)) : null;
  const business = config.data?.business;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable accessibilityRole="button" onPress={() => router.push('/staff')} style={styles.headerButton} hitSlop={8}>
              <Text style={styles.headerButtonText}>Staff</Text>
            </Pressable>
          ),
        }}
      />
      <Screen refreshing={cars.isRefetching} onRefresh={() => void Promise.all([cars.refetch(), config.refetch()])}>
        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Self-drive cars, 12 hr and 24 hr packages</Text>
          <Text style={styles.heroText}>
            {list.length ? `${list.length} well-maintained cars${from ? `, from ${formatRupees(from)}` : ''}. ` : ''}No hidden charges, no driver.
          </Text>
          <View style={styles.heroActions}>
            <Button label="Check a booking" variant="secondary" small onPress={() => router.push('/status')} style={{ flex: 1 }} />
            {business?.phone ? <Button label="Call us" variant="secondary" small onPress={() => void Linking.openURL(`tel:${business.phone}`)} style={{ flex: 1 }} /> : null}
            {business?.whatsapp ? (
              <Button label="WhatsApp" variant="secondary" small onPress={() => void Linking.openURL(whatsappUrl(business.whatsapp))} style={{ flex: 1 }} />
            ) : null}
          </View>
        </View>

        <View style={styles.toggle} accessibilityRole="radiogroup" accessibilityLabel="Show prices for">
          {(['12h', '24h'] as const).map((p) => (
            <Pressable
              key={p}
              accessibilityRole="radio"
              accessibilityState={{ selected: pkg === p }}
              onPress={() => setPkg(p)}
              style={[styles.toggleItem, pkg === p && styles.toggleOn]}
            >
              <Text style={[styles.toggleText, pkg === p && { color: colors.plate }]}>{p === '12h' ? '12 hr prices' : '24 hr prices'}</Text>
            </Pressable>
          ))}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {FILTERS.map((f) => (
            <Chip key={f.id} label={`${f.label} ${list.filter((c) => inFilter(c, f.id)).length}`} selected={filter === f.id} onPress={() => setFilter(f.id)} />
          ))}
        </ScrollView>

        {cars.isLoading ? (
          <Loading label="Loading the fleet…" />
        ) : cars.error ? (
          <ErrorState message={errorText(cars.error)} onRetry={() => void cars.refetch()} />
        ) : (
          <>
            <Muted>{filter === 'all' ? `Showing all ${list.length} cars` : `Showing ${shown.length} of ${list.length} cars`}</Muted>
            {shown.map((car) => (
              <CarCard
                key={car.id}
                car={car}
                pkg={pkg}
                onOpen={() => router.push({ pathname: '/book', params: { car: car.id, pkg } })}
                onBook={() => router.push({ pathname: '/book', params: { car: car.id, pkg } })}
              />
            ))}
          </>
        )}

        <View style={styles.footer}>
          <Text style={styles.footerTitle}>{business?.name || 'KSR Self Drive Cars'}</Text>
          {business?.address ? <Text style={styles.footerText}>{business.address}</Text> : null}
          <View style={styles.links}>
            {[
              ['Privacy', '/privacy'],
              ['Terms', '/terms'],
              ['Cancellation', '/cancellation'],
            ].map(([label, path]) => (
              <Pressable key={path} accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(url + path)} hitSlop={6}>
                <Text style={styles.link}>{label}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="link" onPress={() => router.push('/settings')} hitSlop={6}>
              <Text style={styles.link}>Settings</Text>
            </Pressable>
          </View>
          <Button label="Staff sign-in" variant="secondary" onPress={() => router.push('/staff')} />
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  headerButton: { borderWidth: 1.5, borderColor: colors.plate, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 6 },
  headerButtonText: { color: colors.plate, fontWeight: '800', fontSize: 15 },
  hero: { backgroundColor: colors.ink, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  heroTitle: { color: '#fff', fontSize: 26, fontWeight: '900', letterSpacing: -0.4 },
  heroText: { color: colors.nightMuted, fontSize: 16, lineHeight: 22 },
  heroActions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  toggle: { flexDirection: 'row', backgroundColor: '#fff', borderWidth: 1, borderColor: colors.ink, borderRadius: radius.pill, padding: 4 },
  toggleItem: { flex: 1, minHeight: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  toggleOn: { backgroundColor: '#000' },
  toggleText: { fontWeight: '800', fontSize: 15, color: colors.ink },
  footer: { backgroundColor: colors.ink, borderRadius: radius.lg, padding: space.lg, gap: space.md, marginTop: space.sm },
  footerTitle: { color: '#fff', fontWeight: '800', fontSize: 17 },
  footerText: { color: colors.nightMuted, fontSize: 15 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  link: { color: colors.nightText, fontSize: 15, textDecorationLine: 'underline', paddingVertical: 6 },
});
