import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { BODY_TYPE_LABELS, FUEL_LABELS, TRANSMISSION_LABELS } from '@shared/constants.ts';
import { formatRupees } from '@shared/money.ts';
import { useServer } from '@/lib/server';
import type { PublicCar } from '@/lib/types';
import { carPhotoUrl } from '@/lib/url';
import { colors, radius, space } from '@/theme';
import { Button, Plate } from './ui';

export function CarPhoto({ car, height = 150 }: { car: PublicCar; height?: number }) {
  const { url } = useServer();
  const photo = car.photos[0];
  return (
    <View style={[styles.photo, { height }]}>
      {photo ? (
        <Image source={{ uri: carPhotoUrl(url, photo.path, 800) }} accessibilityLabel={photo.alt || car.display_name} style={StyleSheet.absoluteFill} resizeMode="contain" />
      ) : (
        <Text style={styles.photoText} accessibilityElementsHidden>
          {car.display_name}
        </Text>
      )}
      {car.badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{car.badge}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function CarCard({ car, pkg, onBook, onOpen }: { car: PublicCar; pkg: '12h' | '24h'; onBook: () => void; onOpen: () => void }) {
  const main = pkg === '12h' ? car.price_12h_paise : car.price_24h_paise;
  const alt = pkg === '12h' ? car.price_24h_paise : car.price_12h_paise;
  return (
    <View style={styles.card}>
      <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${car.display_name}, details`}>
        <CarPhoto car={car} />
      </Pressable>
      <View style={{ padding: space.lg, gap: space.md }}>
        <View>
          <Text style={styles.name}>{car.display_name}</Text>
          <Text style={styles.type}>
            {BODY_TYPE_LABELS[car.body_type]} · {car.seats} seats · {FUEL_LABELS[car.fuel]} · {TRANSMISSION_LABELS[car.transmission]}
          </Text>
        </View>
        <View style={styles.prices}>
          <View style={{ gap: 4 }}>
            <Plate>{formatRupees(main)}</Plate>
            <Text style={styles.for}>for {pkg === '12h' ? '12 hrs' : '24 hrs'}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.alt}>{formatRupees(alt)}</Text>
            <Text style={styles.for}>for {pkg === '12h' ? '24 hrs' : '12 hrs'}</Text>
          </View>
        </View>
        <Button label="Book this car" accessibilityLabel={`Book ${car.display_name}`} onPress={onBook} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineCard, overflow: 'hidden' },
  photo: { backgroundColor: colors.tile, alignItems: 'center', justifyContent: 'center' },
  photoText: { fontSize: 22, fontWeight: '900', color: colors.ink2, opacity: 0.5, textAlign: 'center', paddingHorizontal: space.lg },
  badge: { position: 'absolute', top: 12, left: 12, backgroundColor: '#fff', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 13, fontWeight: '800', color: colors.ink },
  name: { fontSize: 21, fontWeight: '800', color: colors.ink },
  type: { fontSize: 14, color: colors.muted, marginTop: 2 },
  prices: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: colors.line, paddingTop: space.md },
  alt: { fontSize: 18, fontWeight: '800', color: colors.ink },
  for: { fontSize: 13, color: colors.muted },
});
