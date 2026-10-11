// Shapes of the JSON values stored in the `settings` table, plus safe defaults.
// Every business rule here is a setting, not code (Section 12, Maintainability).

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

export interface DayHours {
  closed: boolean;
  /** "HH:MM", 24-hour, IST */
  open: string;
  /** "HH:MM", 24-hour, IST. Last pickup time accepted. */
  close: string;
}
export type OpeningHours = Record<Weekday, DayHours>;

export interface BusinessSettings {
  name: string;
  /** E.164, e.g. +919876543210. Empty until the owner sets it (Q1). */
  phone: string;
  whatsapp: string;
  email: string;
  address: string;
  map_url: string;
  hours: OpeningHours;
  grievance_name: string;
  grievance_email: string;
  grievance_phone: string;
}

export interface BookingRules {
  min_lead_hours: number;
  window_days: number;
  time_step_minutes: number;
  turnaround_buffer_minutes: number;
  late_grace_minutes: number;
  late_fee_per_hour_paise: number;
  /** Rate for custom extensions. 0 means "derive from the car's 24 hr price". */
  extra_hour_rate_paise: number;
  default_deposit_paise: number;
  km_limit_12h: number | null;
  km_limit_24h: number | null;
  extra_km_rate_paise: number | null;
  fuel_policy: string;
  no_show_grace_minutes: number;
}

export interface NotificationSettings {
  new_request_emails: string[];
  flagged_emails: string[];
  expiry_emails: string[];
  overdue_emails: string[];
  upload_emails: string[];
  lockout_emails: string[];
}

export interface MessageTemplates {
  confirmation: string;
  reminder: string;
  directions: string;
  upload_link: string;
  rejection: string;
}

/** Non-document retention. Per-document periods live on `document_types.retention_days`. */
export interface RetentionSettings {
  /** Days before unconfirmed / rejected requests are erased. */
  requests_days: number;
  /** Days audit entries are kept; never shorter than the longest document retention. */
  audit_days: number;
  /** Days soft-deleted documents are kept before permanent erasure (DOC-15). */
  soft_delete_days: number;
}

export interface SecuritySettings {
  /** Roles that must complete two-step verification before seeing any data (ADM-03). */
  mfa_required_roles: Array<'owner' | 'manager' | 'staff'>;
  /** Hard session limit (ADM-05). */
  session_hours: number;
  /** Idle sign-out on screens that show documents (ADM-05). */
  document_idle_minutes: number;
}

export interface SettingsMap {
  business: BusinessSettings;
  booking_rules: BookingRules;
  notifications: NotificationSettings;
  templates: MessageTemplates;
  retention: RetentionSettings;
  security: SecuritySettings;
}
export type SettingsKey = keyof SettingsMap;

const day = (open: string, close: string): DayHours => ({ closed: false, open, close });

export const DEFAULT_HOURS: OpeningHours = {
  sun: day('08:00', '20:00'),
  mon: day('08:00', '20:00'),
  tue: day('08:00', '20:00'),
  wed: day('08:00', '20:00'),
  thu: day('08:00', '20:00'),
  fri: day('08:00', '20:00'),
  sat: day('08:00', '20:00'),
};

export const DEFAULT_SETTINGS: SettingsMap = {
  business: {
    name: 'KSR Self Drive Cars',
    phone: '',
    whatsapp: '',
    email: '',
    address: '',
    map_url: '',
    hours: DEFAULT_HOURS,
    grievance_name: '',
    grievance_email: '',
    grievance_phone: '',
  },
  booking_rules: {
    min_lead_hours: 2,
    window_days: 60,
    time_step_minutes: 30,
    turnaround_buffer_minutes: 60,
    late_grace_minutes: 30,
    late_fee_per_hour_paise: 20000,
    extra_hour_rate_paise: 0,
    default_deposit_paise: 0,
    km_limit_12h: null,
    km_limit_24h: null,
    extra_km_rate_paise: null,
    fuel_policy: 'Return the car with the same fuel level as at pickup.',
    no_show_grace_minutes: 60,
  },
  notifications: {
    new_request_emails: [],
    flagged_emails: [],
    expiry_emails: [],
    overdue_emails: [],
    upload_emails: [],
    lockout_emails: [],
  },
  templates: {
    confirmation:
      'Hi {name}, your KSR booking {code} is confirmed: {car}, {package}, pickup {pickup}, return by {return}. Bring your original driving licence and Aadhaar (or passport/voter ID). Pickup: {address}',
    reminder: 'Hi {name}, a reminder that your {car} pickup is at {pickup} (booking {code}). See you soon!',
    directions: 'Hi {name}, here are directions to our pickup point: {map}. Call us on {phone} if you need help.',
    upload_link:
      'Hi {name}, please upload your driving licence photos and a masked Aadhaar (only last 4 digits visible) before pickup: {link} (valid for 24 hours).',
    rejection: 'Hi {name}, sorry, we could not confirm booking {code}. Reason: {reason}. Call us on {phone} to find another option.',
  },
  retention: {
    requests_days: 90,
    audit_days: 365,
    soft_delete_days: 30,
  },
  security: {
    mfa_required_roles: ['owner', 'manager'],
    session_hours: 12,
    document_idle_minutes: 30,
  },
};

/** Keys any visitor may read through the `public_settings` view. */
export const PUBLIC_SETTINGS_KEYS: readonly SettingsKey[] = ['business', 'booking_rules'];

/** Merge stored settings over defaults, so new fields never arrive as undefined. */
export function withDefaults<K extends SettingsKey>(key: K, value: unknown): SettingsMap[K] {
  const base = DEFAULT_SETTINGS[key];
  if (!value || typeof value !== 'object') return base;
  const merged = { ...base, ...(value as object) } as SettingsMap[K];
  if (key === 'business') {
    const b = merged as BusinessSettings;
    b.hours = { ...DEFAULT_HOURS, ...((value as Partial<BusinessSettings>).hours ?? {}) };
  }
  return merged;
}

/** Fill `{placeholder}` tokens in a message template. Unknown tokens are left as-is. */
export function fillTemplate(template: string, values: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = values[key];
    return v === undefined || v === null || v === '' ? match : String(v);
  });
}
