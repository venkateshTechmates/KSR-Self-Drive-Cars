// The demo data used by `npm run seed-demo` and the Playwright tests: every booking state,
// with ledgers that add up.
import { beforeAll, describe, expect, it } from 'vitest';
import { all, one } from '../../server/db/connection.ts';
import { seedDemoData, type DemoResult } from '../../server/demo.ts';
import { createTestDb } from './harness.ts';

let demo: DemoResult;

beforeAll(async () => {
  createTestDb();
  demo = await seedDemoData({ password: 'Demo-pass-2026!', managerEmail: 'manager@demo.test', staffEmail: 'staff@demo.test' });
});

const booking = (code: string) =>
  one<{ status: string; total_paise: number; paid_paise: number; deposit_received_paise: number; deposit_refunded_paise: number; return_due_at: string }>(
    'SELECT status, total_paise, paid_paise, deposit_received_paise, deposit_refunded_paise, return_due_at FROM bookings WHERE booking_code = ?',
    code,
  )!;

describe('demo data', () => {
  it('creates a Manager and a Staff account', () => {
    const roles = all<{ email: string; role: string }>('SELECT u.email, r.role FROM users u JOIN user_roles r ON r.user_id = u.id ORDER BY r.role');
    expect(roles).toEqual([
      { email: 'manager@demo.test', role: 'manager' },
      { email: 'staff@demo.test', role: 'staff' },
    ]);
  });

  it('has a booking in every state', () => {
    const b = demo.bookings;
    expect(booking(b.requested.code).status).toBe('requested');
    expect(booking(b.clashConfirmed.code).status).toBe('confirmed');
    expect(booking(b.pickupToday.code).status).toBe('confirmed');
    expect(booking(b.active.code).status).toBe('active');
    expect(booking(b.overdue.code).status).toBe('active');
    expect(Date.parse(booking(b.overdue.code).return_due_at)).toBeLessThan(Date.now());
    expect(booking(b.returned.code).status).toBe('returned');
    expect(booking(b.closed.code).status).toBe('closed');
    expect(booking(b.rejected.code).status).toBe('rejected');
  });

  it('records payments that leave the returned booking ₹1,500 short and the closed one settled', () => {
    const returned = booking(demo.bookings.returned.code);
    expect(returned.total_paise - returned.paid_paise).toBe(150_000);
    const closed = booking(demo.bookings.closed.code);
    expect(closed.total_paise - closed.paid_paise).toBe(0);
    expect(closed.deposit_received_paise - closed.deposit_refunded_paise).toBe(0);
  });

  it('adds vehicle papers (one expired) and a licence photo waiting to be checked', () => {
    const docs = all<{ doc_type: string; status: string }>('SELECT doc_type, status FROM documents ORDER BY doc_type, status');
    expect(docs).toEqual([
      { doc_type: 'dl_front', status: 'pending' },
      { doc_type: 'insurance', status: 'expired' },
      { doc_type: 'insurance', status: 'verified' },
    ]);
  });
});
