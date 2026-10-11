// Shared domain rules used by both the browser and the edge functions.
import { describe, expect, it } from 'vitest';
import { allowedTransitions, computeReturn, displayStatus, extensionPrice, lateHours, paymentStatus } from '@shared/booking.ts';
import { expiryState, maskDocNumber, sniffMime } from '@shared/documents.ts';
import { formatRupees, parseRupees } from '@shared/money.ts';
import { DEFAULT_HOURS, DEFAULT_SETTINGS, fillTemplate } from '@shared/settings.ts';
import { availableSlots, formatWhen, fromIst, istDateIso, timeSlots } from '@shared/time.ts';
import {
  checkDl,
  MESSAGES,
  normalizePhone,
  validateBookingRequest,
  validateEmail,
  validateName,
  validatePickup,
} from '@shared/validation.ts';

const rules = DEFAULT_SETTINGS.booking_rules;
// Saturday 11 Oct 2026, 09:00 IST
const NOW = fromIst('2026-10-11', '09:00')!;
const ctx = { rules, hours: DEFAULT_HOURS, now: NOW };

describe('mobile numbers (Appendix A)', () => {
  it.each([
    ['98765 43210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['6000000000', '+916000000000'],
  ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each(['5876543210', '98765', '+1 202 555 0100', ''])('rejects %s', (input) => expect(normalizePhone(input)).toBeNull());
});

describe('driving licence (Appendix A)', () => {
  it('uppercases and strips spaces and hyphens', () => {
    expect(checkDl('ts09 2011-0012345')).toEqual({ value: 'TS0920110012345', error: null, oldFormat: false });
  });
  it('accepts older formats with a warning flag, not an error', () => {
    expect(checkDl('AP12345/2004')).toMatchObject({ error: null, oldFormat: true });
  });
  it('requires a value', () => expect(checkDl('  ').error).toBe(MESSAGES.dlRequired));
});

describe('names and emails', () => {
  it('accepts letters in any script, spaces and . \' -', () => {
    expect(validateName("Ravi K. D'Souza-Rao")).toBeNull();
    expect(validateName('రవి కుమార్')).toBeNull();
  });
  it('rejects digits and too-short names', () => {
    expect(validateName('R2D2')).toBe(MESSAGES.nameInvalid);
    expect(validateName('R')).toBe(MESSAGES.nameInvalid);
  });
  it('email is optional but must be valid', () => {
    expect(validateEmail('')).toBeNull();
    expect(validateEmail('a@b.in')).toBeNull();
    expect(validateEmail('a@b')).toBe(MESSAGES.emailInvalid);
  });
});

describe('pickup rules', () => {
  it('needs a date and time', () => expect(validatePickup('', '', ctx)).toBe(MESSAGES.pickupMissing));
  it('enforces the minimum notice', () => expect(validatePickup('2026-10-11', '10:00', ctx)).toBe(MESSAGES.pickupTooSoon(2)));
  it('enforces opening hours', () => expect(validatePickup('2026-10-12', '21:00', ctx)).toMatch(/between 8:00 am and 8:00 pm/));
  it('enforces 30-minute steps', () => expect(validatePickup('2026-10-12', '10:15', ctx)).toMatch(/30-minute step/));
  it('enforces the booking window', () => expect(validatePickup('2026-12-31', '10:00', ctx)).toBe(MESSAGES.pickupTooFar(60)));
  it('accepts a valid slot', () => expect(validatePickup('2026-10-12', '10:00', ctx)).toBeNull());
  it('walk-ins created by staff skip the notice period', () =>
    expect(validatePickup('2026-10-11', '09:10', { ...ctx, skipLeadTime: true })).toBeNull());
  it('closed days are refused', () => {
    const hours = { ...DEFAULT_HOURS, sun: { closed: true, open: '08:00', close: '20:00' } };
    expect(validatePickup('2026-10-18', '10:00', { ...ctx, hours })).toBe(MESSAGES.pickupClosed('Sunday'));
  });
});

describe('slots', () => {
  it('lists 30-minute slots within opening hours', () => {
    const slots = timeSlots(DEFAULT_HOURS.mon, 30);
    expect(slots[0]).toBe('08:00');
    expect(slots.at(-1)).toBe('20:00');
    expect(slots).toHaveLength(25);
  });
  it('drops slots inside the notice period today', () => {
    expect(availableSlots('2026-10-11', DEFAULT_HOURS, 30, 2, NOW)[0]).toBe('11:00');
  });
});

describe('IST time', () => {
  it('converts IST wall time to UTC', () => expect(fromIst('2026-10-12', '10:00')!.toISOString()).toBe('2026-10-12T04:30:00.000Z'));
  it('formats like the design', () => expect(formatWhen('2026-10-12T04:30:00Z')).toBe('Mon, 12 Oct, 10:00 am'));
  it('uses the IST calendar day', () => expect(istDateIso('2026-10-11T19:00:00Z')).toBe('2026-10-12'));
});

describe('whole booking request (BK-03..BK-08)', () => {
  const base = {
    car_id: '00000000-0000-4000-a000-000000000001',
    package: '24h',
    pickup_date: '2026-10-12',
    pickup_time: '10:00',
    full_name: 'Ravi Kumar',
    phone: '98765 43210',
    dl_number: 'ts0920110012345',
    consent: true,
  };
  it('normalises a valid request', () => {
    const v = validateBookingRequest(base, ctx);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value).toMatchObject({ phone: '+919876543210', dl_number: 'TS0920110012345', package: '24h', email: null });
      // AC-01: return time is pickup + 24 hours.
      expect(computeReturn(v.value.pickup_at, '24h').toISOString()).toBe('2026-10-13T04:30:00.000Z');
    }
  });
  it('lists every problem at once', () => {
    const v = validateBookingRequest({ ...base, pickup_time: '', phone: '123', consent: false }, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(Object.keys(v.errors).sort()).toEqual(['consent', 'phone', 'pickup']);
  });
});

describe('booking lifecycle (Section 7)', () => {
  it('staff can hand over and mark no-show but not confirm', () => {
    expect(allowedTransitions('requested', 'staff')).toEqual([]);
    expect(allowedTransitions('confirmed', 'staff').map((t) => t.action)).toEqual(['pickup', 'no_show']);
    expect(allowedTransitions('requested', 'manager').map((t) => t.action)).toEqual(['confirm', 'reject', 'cancel']);
  });
  it('overdue is derived, not stored', () => {
    expect(displayStatus({ status: 'active', return_due_at: '2026-10-11T00:00:00Z' }, NOW)).toBe('overdue');
    expect(displayStatus({ status: 'confirmed', return_due_at: '2026-10-11T00:00:00Z' }, NOW)).toBe('confirmed');
  });
  it('late hours start after the grace period (BKA-10)', () => {
    expect(lateHours('2026-10-11T10:00:00Z', '2026-10-11T10:25:00Z', 30)).toBe(0);
    expect(lateHours('2026-10-11T10:00:00Z', '2026-10-11T11:31:00Z', 30)).toBe(2);
  });
  it('custom extensions use the 24 hr price spread over 24 hours by default (BKA-09)', () => {
    expect(extensionPrice({ price_12h_paise: 180000, price_24h_paise: 350000 }, { kind: 'hours', hours: 3 }, { extra_hour_rate_paise: 0 })).toBe(3 * 14600);
  });
  it('payment status follows the ledger (PAY-02)', () => {
    expect(paymentStatus({ totalPaise: 180000, paidPaise: 0, refundedPaise: 0 })).toBe('unpaid');
    expect(paymentStatus({ totalPaise: 180000, paidPaise: 50000, refundedPaise: 0 })).toBe('part_paid');
    expect(paymentStatus({ totalPaise: 180000, paidPaise: 180000, refundedPaise: 0 })).toBe('paid');
    expect(paymentStatus({ totalPaise: 180000, paidPaise: 0, refundedPaise: 180000 })).toBe('refunded');
  });
});

describe('money', () => {
  it('uses Indian digit grouping', () => {
    expect(formatRupees(130000)).toBe('₹1,300');
    expect(formatRupees(10000000)).toBe('₹1,00,000');
    expect(formatRupees(150050)).toBe('₹1,500.50');
  });
  it('parses typed amounts', () => {
    expect(parseRupees('₹ 1,800')).toBe(180000);
    expect(parseRupees('12.5')).toBe(1250);
    expect(parseRupees('abc')).toBeNull();
  });
});

describe('documents', () => {
  it('detects real file types from content (10.5)', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7 rest of file'))).toBe('application/pdf');
    expect(sniffMime(new TextEncoder().encode('<html><script>x</script>'))).toBeNull();
  });
  it('tracks expiry: valid, expiring within 30 days, expired (DOC-12)', () => {
    expect(expiryState('2026-12-31', '2026-10-11')).toBe('valid');
    expect(expiryState('2026-11-05', '2026-10-11')).toBe('expiring_soon');
    expect(expiryState('2026-10-10', '2026-10-11')).toBe('expired');
  });
  it('masks document numbers to the last 4 characters', () => expect(maskDocNumber('TS0920110012345')).toBe('XXXXXXXXXXX2345'));
});

describe('message templates (SET-04)', () => {
  it('fills known placeholders and leaves unknown ones', () => {
    expect(fillTemplate('Hi {name}, booking {code} {other}', { name: 'Ravi', code: 'KSR-261012-001' })).toBe('Hi Ravi, booking KSR-261012-001 {other}');
  });
});
