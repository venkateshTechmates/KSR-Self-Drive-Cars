// Files on disk: signed private document links (/api/files/:token), car photo uploads
// (/api/storage/car-photos/...) and public car photos (/media/car-photos/...).
// CONTRACT STUB.
import { Hono } from 'hono';
import type { AppEnv } from '../http.ts';

export const fileRoutes = new Hono<AppEnv>();
