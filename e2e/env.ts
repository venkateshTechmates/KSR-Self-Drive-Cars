// Settings shared by the e2e server (start-server.ts), playwright.config.ts and the specs.
export const E2E = {
  port: 8091,
  baseURL: 'http://localhost:8091',
  /** A fresh database and files folder for every run (deleted on start). */
  dataDir: 'node_modules/.tmp/e2e-data',
  appSecret: 'e2e-only-secret-0123456789abcdef0123456789abcdef',
  password: 'Demo-pass-2026!',
  owner: { email: 'owner@ksr.test', name: 'Kiran Sai' },
  manager: { email: 'manager@ksr.test' },
  staff: { email: 'staff@ksr.test' },
  /** The Manager is enrolled with this authenticator secret; the Owner enrols in the setup test. */
  managerTotpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  /** Signed-in browser states written by auth.setup.ts. */
  authDir: 'node_modules/.tmp/e2e-auth',
} as const;
