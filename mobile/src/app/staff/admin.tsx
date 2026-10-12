// The full web admin inside the app, for everything the native screens don't cover (handover
// with photos and signature, documents, fleet, customers, reports, settings, staff). It uses
// the same sign-in: Android shares the session cookie between the app and this web view.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, View } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { useServer } from '@/lib/server';
import { colors } from '@/theme';

export default function FullAdmin() {
  const { path } = useLocalSearchParams<{ path?: string }>();
  const { url } = useServer();
  const ref = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const start = `${url}${path && path.startsWith('/admin') ? path : '/admin'}`;

  // Android back goes back inside the admin first.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack) return false;
      ref.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, [canGoBack]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.page }}>
      <Stack.Screen options={{ title: 'Full admin' }} />
      <WebView
        ref={ref}
        source={{ uri: start }}
        onNavigationStateChange={(s: WebViewNavigation) => setCanGoBack(s.canGoBack)}
        // Phone, WhatsApp, Maps and other sites open in their own apps.
        onShouldStartLoadWithRequest={(req) => {
          if (req.url.startsWith(url) || req.url.startsWith('about:') || req.url.startsWith('blob:') || req.url.startsWith('data:')) return true;
          void Linking.openURL(req.url);
          return false;
        }}
        setSupportMultipleWindows={false}
        allowFileAccess
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        startInLoadingState
        renderLoading={() => (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.action} size="large" />
          </View>
        )}
        style={{ flex: 1 }}
      />
    </View>
  );
}
