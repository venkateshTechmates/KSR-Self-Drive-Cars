// The single service: API, files and the built web app.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { authRoutes } from './auth/routes.ts';
import { config } from './config.ts';
import { all } from './db/connection.ts';
import { contextMiddleware, csrfGuard, errorResponse, type AppEnv } from './http.ts';
import { apiRoutes } from './routes/api.ts';
import { fileRoutes } from './routes/files.ts';
import { functionRoutes } from './routes/functions.ts';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => errorResponse(c, err));

  // Security headers (10.5).
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    // The admin shows PDFs from signed /api/files links in an iframe on the same site.
    c.header('X-Frame-Options', c.req.path.startsWith('/api/files/') ? 'SAMEORIGIN' : 'DENY');
    c.header('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
    if (config.siteUrl.startsWith('https://')) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (c.req.path.startsWith('/admin') || c.req.path.startsWith('/upload/')) c.header('X-Robots-Tag', 'noindex, nofollow');
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.use('/api/*', contextMiddleware);
  app.use('/api/*', csrfGuard);
  app.route('/api/auth', authRoutes);
  app.route('/api/fn', functionRoutes);
  app.route('/api', apiRoutes);
  app.route('/', fileRoutes);
  app.all('/api/*', (c) => c.json({ message: 'Not found.', details: 'not_found', hint: null, code: 'PGRST404' }, 404));

  // SEO (WEB-04): robots.txt and a sitemap that always lists the live car pages.
  app.get('/robots.txt', (c) =>
    c.text(
      ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /upload/', 'Disallow: /booking-status', '', `Sitemap: ${config.siteUrl}/sitemap.xml`, ''].join('\n'),
    ),
  );
  app.get('/sitemap.xml', (c) => {
    const cars = all<{ slug: string; updated_at: string }>(`SELECT slug, updated_at FROM cars WHERE status = 'active' ORDER BY sort_order`);
    const urls = [
      ...['/', '/privacy', '/terms', '/cancellation'].map((p) => ({ loc: p, lastmod: null as string | null })),
      ...cars.map((car) => ({ loc: `/cars/${car.slug}`, lastmod: car.updated_at.slice(0, 10) })),
    ];
    const lines = urls.map((u) => `  <url><loc>${config.siteUrl}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`);
    c.header('Content-Type', 'application/xml; charset=utf-8');
    return c.body(
      ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...lines, '</urlset>', ''].join('\n'),
    );
  });

  // The built web app (vite build → dist/), with SPA fallback to index.html.
  if (existsSync(join(config.distDir, 'index.html'))) {
    const indexHtml = readFileSync(join(config.distDir, 'index.html'), 'utf8');
    app.use(
      '/assets/*',
      serveStatic({ root: config.distDir, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }),
    );
    app.use('*', serveStatic({ root: config.distDir }));
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  }

  return app;
}
