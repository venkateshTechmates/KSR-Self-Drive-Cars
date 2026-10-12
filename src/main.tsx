import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { App } from './App';
import { initAnalytics } from './lib/analytics';
import { initNativeApp } from './lib/native';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

initAnalytics();
// Android app only: back button, new-tab links, file sharing (a no-op in browsers).
void initNativeApp();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster position="top-center" toastOptions={{ style: { fontFamily: 'inherit', borderRadius: 12 } }} />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
