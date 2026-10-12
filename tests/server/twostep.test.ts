// TWO_STEP=off (server/config.ts): two-step verification switched off for everyone, without
// touching the saved Security setting.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mfaRequired } from '../../server/access/context.ts';
import { config } from '../../server/config.ts';
import { myAccess } from '../../server/rpc/misc.ts';
import { getSetting } from '../../server/settings.ts';
import { addStaff, createTestDb, type TestUser } from './harness.ts';

let owner: TestUser;
let manager: TestUser;
const original = config.twoStep;

beforeAll(() => {
  createTestDb();
  owner = addStaff('owner', 'o');
  manager = addStaff('manager', 'm');
});
afterEach(() => {
  config.twoStep = original;
});

describe('TWO_STEP switch', () => {
  it('on (the default): Owners and Managers have no data access until they enter a code', () => {
    config.twoStep = true;
    expect(mfaRequired('owner')).toBe(true);
    expect(owner.ctxAal1().role).toBeNull();
    expect(manager.ctxAal1().role).toBeNull();
    expect(myAccess(owner.ctxAal1())).toMatchObject({ mfa_required: true, effective_role: null, two_step_switched_off: false });
  });

  it('off: everyone works straight after the password, and the apps are told', () => {
    config.twoStep = false;
    expect(mfaRequired('owner')).toBe(false);
    expect(owner.ctxAal1().role).toBe('owner');
    expect(manager.ctxAal1().role).toBe('manager');
    expect(myAccess(owner.ctxAal1())).toMatchObject({ mfa_required: false, effective_role: 'owner', two_step_switched_off: true });
  });

  it('keeps the saved Security setting, so switching back on restores it', () => {
    config.twoStep = false;
    expect(getSetting('security').mfa_required_roles).toEqual(['owner', 'manager']);
  });
});
