// App shell: server address, data cache, staff sign-in state and the screen stack.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '@/lib/auth';
import { ServerProvider } from '@/lib/server';
import { colors } from '@/theme';

export default function RootLayout() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } }),
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        {/* A new server address starts from a clean cache and signs staff out. */}
        <ServerProvider onChange={() => queryClient.clear()}>
          <AuthProvider>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.ink },
                headerTintColor: '#fff',
                headerTitleStyle: { fontWeight: '800' },
                contentStyle: { backgroundColor: colors.page },
              }}
            >
              <Stack.Screen name="index" options={{ title: 'KSR Self Drive Cars' }} />
              <Stack.Screen name="book" options={{ title: 'Book a car' }} />
              <Stack.Screen name="status" options={{ title: 'Check a booking' }} />
              <Stack.Screen name="settings" options={{ title: 'Settings' }} />
              <Stack.Screen name="staff/login" options={{ title: 'Staff sign-in' }} />
              <Stack.Screen name="staff/mfa" options={{ title: 'Two-step verification' }} />
              <Stack.Screen name="staff/index" options={{ title: 'Dashboard' }} />
              <Stack.Screen name="staff/bookings" options={{ title: 'Bookings' }} />
              <Stack.Screen name="staff/booking/[code]" options={{ title: 'Booking' }} />
              <Stack.Screen name="staff/admin" options={{ title: 'Full admin' }} />
            </Stack>
          </AuthProvider>
        </ServerProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
