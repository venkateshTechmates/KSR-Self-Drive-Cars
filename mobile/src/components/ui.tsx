// Small UI kit in the website's style: ink, page grey, action green and the yellow number plate.
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, space } from '../theme';

export function Screen({
  children,
  refreshing,
  onRefresh,
  contentStyle,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.page }}
      contentContainerStyle={[{ padding: space.lg, paddingBottom: space.xl + insets.bottom, gap: space.lg }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} colors={[colors.action]} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function H1({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.h1} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function H2({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.h2Row}>
      <Text style={styles.h2} accessibilityRole="header">
        {children}
      </Text>
      {right}
    </View>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      <Text style={styles.muted}>{children}</Text>
    </View>
  );
}

type Variant = 'primary' | 'dark' | 'secondary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  small,
  style,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const v = VARIANTS[variant];
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(off), busy: Boolean(loading) }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: pressed ? v.pressed : v.bg, borderColor: v.border },
        off && { opacity: 0.55 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={v.fg} /> : <Text style={[styles.buttonText, small && { fontSize: 15 }, { color: v.fg }]}>{label}</Text>}
    </Pressable>
  );
}

const VARIANTS: Record<Variant, { bg: string; pressed: string; fg: string; border: string }> = {
  primary: { bg: colors.action, pressed: colors.actionPressed, fg: '#fff', border: colors.action },
  dark: { bg: colors.ink, pressed: '#000', fg: '#fff', border: colors.ink },
  secondary: { bg: colors.surface, pressed: colors.subtle, fg: colors.ink, border: colors.ink },
  danger: { bg: colors.danger, pressed: '#6a1b0d', fg: '#fff', border: colors.danger },
  ghost: { bg: 'transparent', pressed: colors.tile, fg: colors.ink, border: 'transparent' },
};

export function Chip({ label, selected, onPress, disabled, note }: { label: string; selected?: boolean; onPress: () => void; disabled?: boolean; note?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipOn, disabled && { opacity: 0.45 }]}
    >
      <Text style={[styles.chipText, selected && { color: '#fff' }]}>{label}</Text>
      {note ? <Text style={[styles.chipNote, selected && { color: colors.plate }]}>{note}</Text> : null}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  hint,
  optional,
  ...input
}: TextInputProps & { label: string; error?: string | null; hint?: string; optional?: boolean }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>
        {label}
        {optional ? <Text style={styles.optional}> (optional)</Text> : null}
      </Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#8a918b"
        style={[styles.input, error ? styles.inputError : null]}
        {...input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Checkbox({ checked, onChange, children, error }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; error?: string | null }) {
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        onPress={() => onChange(!checked)}
        style={[styles.checkRow, error ? { borderColor: colors.danger } : null]}
      >
        <View style={[styles.box, checked && styles.boxOn]}>{checked ? <Text style={styles.tick}>✓</Text> : null}</View>
        <View style={{ flex: 1 }}>{children}</View>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

type Tone = 'grey' | 'green' | 'amber' | 'red' | 'blue' | 'dark';
const TONES: Record<Tone, { bg: string; fg: string }> = {
  grey: { bg: colors.tile, fg: colors.ink2 },
  green: { bg: colors.greenBg, fg: colors.green },
  amber: { bg: colors.amberBg, fg: colors.amber },
  red: { bg: colors.dangerBg, fg: colors.danger },
  blue: { bg: colors.blueBg, fg: colors.blue },
  dark: { bg: colors.ink, fg: '#fff' },
};

export function Pill({ label, tone = 'grey' }: { label: string; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }]}>
      <Text style={[styles.pillText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

/** The yellow number plate the website uses for prices. */
export function Plate({ children, big }: { children: string; big?: boolean }) {
  return (
    <View style={[styles.plate, big && { paddingHorizontal: 14, paddingVertical: 6 }]}>
      <Text style={[styles.plateText, big && { fontSize: 30 }]}>{children}</Text>
    </View>
  );
}

export function Notice({ children, tone = 'red', title }: { children?: ReactNode; tone?: 'red' | 'amber' | 'green' | 'blue'; title?: string }) {
  const t = TONES[tone];
  return (
    <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: t.bg, borderColor: t.fg }]}>
      {title ? <Text style={[styles.noticeTitle, { color: t.fg }]}>{title}</Text> : null}
      {typeof children === 'string' ? <Text style={{ color: t.fg, fontSize: 15 }}>{children}</Text> : children}
    </View>
  );
}

/** Label and value on one line; `dark` for the ink summary panels. */
export function Row({ label, value, strong, dark }: { label: string; value: ReactNode; strong?: boolean; dark?: boolean }) {
  return (
    <View style={[styles.row, dark && { borderBottomColor: '#3a4046' }]}>
      <Text style={[styles.rowLabel, dark && { color: colors.nightMuted }]}>{label}</Text>
      {typeof value === 'string' ? (
        <Text style={[styles.rowValue, strong && { fontWeight: '800' }, dark && { color: colors.nightText }]}>{value}</Text>
      ) : (
        value
      )}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.center} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.action} size="large" />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={[styles.center, { gap: space.md }]}>
      <Notice title="Couldn't load this">{message}</Notice>
      {onRetry ? <Button label="Try again" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineCard, padding: space.lg, gap: space.md },
  h1: { fontSize: 30, fontWeight: '900', color: colors.ink, letterSpacing: -0.5 },
  h2Row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  h2: { fontSize: 18, fontWeight: '800', color: colors.ink, flexShrink: 1 },
  muted: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  button: { minHeight: 52, borderRadius: radius.md, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  buttonSmall: { minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.sm },
  buttonText: { fontSize: 17, fontWeight: '700' },
  chip: { minHeight: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.lineInput, backgroundColor: colors.surface, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center' },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 15, fontWeight: '700', color: colors.ink },
  chipNote: { fontSize: 12, color: colors.muted, marginTop: 1 },
  label: { fontSize: 15, fontWeight: '700', color: colors.ink },
  optional: { fontWeight: '400', color: colors.muted },
  input: { minHeight: 52, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineInput, backgroundColor: '#fff', paddingHorizontal: 14, fontSize: 17, color: colors.ink },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  error: { color: colors.danger, fontWeight: '700', fontSize: 14 },
  hint: { color: colors.muted, fontSize: 14 },
  checkRow: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start', padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.subtle },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', marginTop: 1 },
  boxOn: { backgroundColor: colors.ink },
  tick: { color: '#fff', fontWeight: '900', fontSize: 15, lineHeight: 18 },
  pill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' },
  pillText: { fontSize: 13, fontWeight: '800' },
  plate: { backgroundColor: colors.plate, borderWidth: 2, borderColor: colors.ink, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' },
  plateText: { fontSize: 20, fontWeight: '900', color: colors.ink, letterSpacing: 0.5 },
  notice: { borderLeftWidth: 4, borderRadius: radius.sm, padding: space.md, gap: 4 },
  noticeTitle: { fontWeight: '800', fontSize: 15 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLabel: { color: colors.muted, fontSize: 15 },
  rowValue: { color: colors.ink, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  center: { padding: space.xl, alignItems: 'center', justifyContent: 'center', gap: space.sm },
});
