import { useEffect } from 'react';

const SITE = (import.meta.env.VITE_SITE_URL ?? '').replace(/\/$/, '');

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

/** Unique title and description per page (WEB-04); `noindex` for admin pages (ADM-01). */
export function useDocumentMeta(opts: { title: string; description?: string; path?: string; noindex?: boolean }) {
  const { title, description, path, noindex } = opts;
  useEffect(() => {
    document.title = title;
    if (description) {
      setMeta('name', 'description', description);
      setMeta('property', 'og:description', description);
    }
    setMeta('property', 'og:title', title);
    setMeta('name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow');
    if (path !== undefined && SITE) {
      let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'canonical';
        document.head.appendChild(link);
      }
      link.href = `${SITE}${path}`;
      setMeta('property', 'og:url', `${SITE}${path}`);
    }
  }, [title, description, path, noindex]);
}
