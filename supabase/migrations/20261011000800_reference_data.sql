-- Reference data: settings defaults, document types (6.8.1), draft policies (Appendix B)
-- and the current fleet of 11 cars. Everything here is editable from the admin afterwards.
-- Bracketed values such as [Owner to confirm] are open questions from Section 15.

-- ------------------------------------------------------------------ settings (SET-01, SET-02, SET-07, SET-04)
insert into public.settings (key, value) values
('business', $json${
  "name": "KSR Self Drive Cars",
  "phone": "",
  "whatsapp": "",
  "email": "",
  "address": "",
  "map_url": "",
  "hours": {
    "sun": {"closed": false, "open": "08:00", "close": "20:00"},
    "mon": {"closed": false, "open": "08:00", "close": "20:00"},
    "tue": {"closed": false, "open": "08:00", "close": "20:00"},
    "wed": {"closed": false, "open": "08:00", "close": "20:00"},
    "thu": {"closed": false, "open": "08:00", "close": "20:00"},
    "fri": {"closed": false, "open": "08:00", "close": "20:00"},
    "sat": {"closed": false, "open": "08:00", "close": "20:00"}
  },
  "grievance_name": "",
  "grievance_email": "",
  "grievance_phone": ""
}$json$::jsonb),
('booking_rules', $json${
  "min_lead_hours": 2,
  "window_days": 60,
  "time_step_minutes": 30,
  "turnaround_buffer_minutes": 60,
  "late_grace_minutes": 30,
  "late_fee_per_hour_paise": 20000,
  "extra_hour_rate_paise": 0,
  "default_deposit_paise": 0,
  "km_limit_12h": null,
  "km_limit_24h": null,
  "extra_km_rate_paise": null,
  "fuel_policy": "Return the car with the same fuel level as at pickup.",
  "no_show_grace_minutes": 60
}$json$::jsonb),
('notifications', $json${
  "new_request_emails": [],
  "flagged_emails": [],
  "expiry_emails": [],
  "overdue_emails": [],
  "upload_emails": [],
  "lockout_emails": []
}$json$::jsonb),
('templates', $json${
  "confirmation": "Hi {name}, your KSR booking {code} is confirmed: {car}, {package}, pickup {pickup}, return by {return}. Bring your original driving licence and Aadhaar (or passport/voter ID). Pickup: {address}",
  "reminder": "Hi {name}, a reminder that your {car} pickup is at {pickup} (booking {code}). See you soon!",
  "directions": "Hi {name}, here are directions to our pickup point: {map}. Call us on {phone} if you need help.",
  "upload_link": "Hi {name}, please upload your driving licence photos and a masked Aadhaar (only last 4 digits visible) before pickup: {link} (valid for 24 hours).",
  "rejection": "Hi {name}, sorry, we could not confirm booking {code}. Reason: {reason}. Call us on {phone} to find another option."
}$json$::jsonb),
('retention', $json${
  "requests_days": 90,
  "audit_days": 365,
  "soft_delete_days": 30
}$json$::jsonb),
('security', $json${
  "mfa_required_roles": ["owner", "manager"],
  "session_hours": 12,
  "document_idle_minutes": 30
}$json$::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------------ document types (6.8.1)
insert into public.document_types
  (key, label, owner_type, is_kyc, tracks_expiry, expiry_required, blocks_booking_when_expired, required_for_pickup,
   view_roles, download_roles, retention_days, retention_basis, sort_order)
values
  -- Customer KYC: Staff may view for today's bookings, never download.
  ('dl_front', 'Driving licence – front', 'customer', true, true, false, false, true,
   '{owner,manager,staff}', '{owner,manager}', 180, 'customer_last_booking_end', 10),
  ('dl_back', 'Driving licence – back', 'customer', true, false, false, false, false,
   '{owner,manager,staff}', '{owner,manager}', 180, 'customer_last_booking_end', 20),
  ('aadhaar_masked', 'Aadhaar – masked copy', 'customer', true, false, false, false, false,
   '{owner,manager,staff}', '{owner,manager}', 30, 'customer_last_booking_end', 30),
  ('other_photo_id', 'Other photo ID (passport, voter ID, PAN)', 'customer', true, true, false, false, false,
   '{owner,manager,staff}', '{owner,manager}', 180, 'customer_last_booking_end', 40),
  -- Booking paperwork
  ('customer_photo', 'Photo of customer with licence at handover', 'booking', true, false, false, false, false,
   '{owner,manager,staff}', '{owner,manager}', 180, 'booking_end', 100),
  ('rental_agreement', 'Signed rental agreement', 'booking', false, false, false, false, false,
   '{owner,manager,staff}', '{owner,manager,staff}', null, 'none', 110),
  ('signature', 'Customer signature', 'booking', false, false, false, false, false,
   '{owner,manager,staff}', '{owner,manager}', 180, 'booking_end', 115),
  ('pickup_photos', 'Pickup photos', 'booking', false, false, false, false, false,
   '{owner,manager,staff}', '{owner,manager,staff}', 180, 'booking_end', 120),
  ('return_photos', 'Return photos', 'booking', false, false, false, false, false,
   '{owner,manager,staff}', '{owner,manager,staff}', 180, 'booking_end', 130),
  ('damage_photos', 'Damage photos and repair estimate', 'booking', false, false, false, false, false,
   '{owner,manager}', '{owner,manager}', 180, 'booking_end', 140),
  ('payment_receipt', 'Payment receipt / UPI screenshot', 'booking', false, false, false, false, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 150),
  ('challan', 'Traffic challan / fine notice', 'booking', false, false, false, false, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 160),
  ('claim_report', 'Insurance claim or police report', 'booking', false, false, false, false, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 170),
  -- Vehicle papers (Owner review on retention, so no automatic erasure)
  ('rc', 'Registration certificate (RC)', 'car', false, false, false, false, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 200),
  ('insurance', 'Insurance policy', 'car', false, true, true, true, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 210),
  ('puc', 'PUC certificate', 'car', false, true, true, true, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 220),
  ('permit', 'Permit / rent-a-cab authorisation', 'car', false, true, true, true, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 230),
  ('fitness', 'Fitness certificate', 'car', false, true, true, false, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 240),
  ('road_tax', 'Road tax receipt', 'car', false, true, false, false, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 250),
  ('fastag', 'FASTag details', 'car', false, false, false, false, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 260),
  ('service_invoice', 'Service invoice', 'car', false, false, false, false, false,
   '{owner,manager}', '{owner,manager}', null, 'none', 270),
  -- Business papers: Owner only
  ('gst_registration', 'GST registration', 'business', false, true, false, false, false,
   '{owner}', '{owner}', null, 'none', 300),
  ('trade_licence', 'Trade licence', 'business', false, true, false, false, false,
   '{owner}', '{owner}', null, 'none', 310),
  ('business_insurance', 'Business insurance', 'business', false, true, false, false, false,
   '{owner}', '{owner}', null, 'none', 320),
  ('agreement_template', 'Agreement template', 'business', false, false, false, false, false,
   '{owner}', '{owner}', null, 'none', 330)
on conflict (key) do nothing;

-- ------------------------------------------------------------------ policies (WEB-10, Appendix B)
-- Placeholders in {braces} are filled from Settings when the page is shown.
insert into public.policy_versions (kind, locale, version, title, body_md) values
('privacy', 'en', 1, 'Privacy notice', $md$
_Draft for legal review. Version 1._

## Who we are

KSR Self Drive Cars ("we", "us") rents self-drive cars. Pickup: {address}. Phone: {phone}. Email: {email}.

## What we collect

- Your name, mobile number and, if you give it, your email address.
- Your driving licence number, its expiry date and photos of your licence.
- The result of your identity check at pickup, and the last 4 digits of your Aadhaar number or details of the other photo ID you show. We never ask for your full Aadhaar number online. If we keep a copy of your Aadhaar, it is masked so only the last 4 digits can be seen.
- Booking records: the car, pickup and return times, handover and return checklists, photos of the car, and your signature.
- Payments you make to us.

## Why we use it

- To process your booking and contact you about it.
- To check that you can drive legally and that you are who you say you are.
- For safety, and to deal with traffic fines, damage and insurance claims linked to your rental.
- To keep our accounts.

We use these details because you agree to it when you send a booking request, or where the law requires us to.

## How long we keep it

- Masked Aadhaar copy: until your booking closes, plus 30 days.
- Driving licence photos: 6 months after your last booking ends.
- Handover and return photos and your signature: 6 months after the booking ends, or longer while a fine, claim or dispute is open.
- Booking and payment records: as long as tax and accounting law requires.
- Booking requests that were not confirmed: 90 days.

## Who we share it with

Only with service providers that host our systems for us, and with authorities when the law requires it, for example the police or transport department for a traffic offence. We do not sell your data.

## Your rights

You can ask for a copy of your data, ask us to correct it, or ask us to erase it. We can't erase records while a booking, payment, fine or claim is still open; we'll tell you if that applies. You can withdraw your consent at any time; this doesn't affect what we did before.

## Grievances

Contact our grievance officer: {grievance_name}, {grievance_email}, {grievance_phone}. If you are not satisfied with our answer, you can complain to the Data Protection Board of India.

## Changes

When we change this notice, we publish a new version here with its date.
$md$),
('terms', 'en', 1, 'Terms of rental', $md$
_Draft for legal review. Version 1._

## Who can rent

- You must hold a valid driving licence for the car you rent. [Owner to confirm minimum age and years of driving experience.]
- Bring your original driving licence and Aadhaar (or passport / voter ID) to the pickup. We verify them before handing over the keys.

## Packages and price

- Each car has a 12 hr and a 24 hr package. The price shown when you book is the price you pay for that package.
- The return time is your pickup time plus 12 or 24 hours.
- A security deposit may be collected at pickup and refunded after the car is returned and checked. [Owner to confirm amount.]

## Fuel

{fuel_policy}

## Late return

If you return the car late, late hours are charged as shown at the counter. [Owner to confirm grace period and hourly fee.]

## Your responsibilities

- Drive safely and follow traffic rules. Traffic fines (challans) during your rental are your responsibility.
- Don't let anyone else drive the car unless we have agreed and checked their licence.
- Don't use the car for racing, towing, commercial carriage of passengers or goods, or anything illegal.
- Report any accident, damage or breakdown to us straight away on {phone}.

## Damage

We note the car's condition with you at pickup and return, with photos. New damage, extra cleaning and missing accessories are charged as itemised on your final bill.

## Cancellation

See our cancellation policy.
$md$),
('cancellation', 'en', 1, 'Cancellation policy', $md$
_Draft for legal review. Version 1._

[Owner to confirm the cancellation and refund rules (Section 15, Q7).]

- Booking requests are free until we confirm them.
- To cancel a confirmed booking, call us on {phone}.
- Refunds of any advance are made to the original payment method.
$md$)
on conflict (kind, locale, version) do nothing;

-- ------------------------------------------------------------------ fleet (current site, 11 cars)
-- "Victoris" is Maruti's spelling (gap G8); the Owner can change any name in the admin (FLT-02).
insert into public.cars
  (slug, display_name, brand, model, body_type, category, seats, fuel, transmission, badge, price_12h_paise, price_24h_paise, sort_order)
values
  ('kia-sonet', 'Kia Sonet', 'Kia', 'Sonet', 'compact_suv', 'suv', 5, 'petrol', 'manual', 'Premium', 180000, 350000, 10),
  ('toyota-glanza', 'Toyota Glanza', 'Toyota', 'Glanza', 'hatchback', 'hatch', 5, 'petrol', 'manual', null, 150000, 250000, 20),
  ('maruti-suzuki-fronx', 'Maruti Suzuki Fronx', 'Maruti Suzuki', 'Fronx', 'crossover', 'suv', 5, 'petrol', 'manual', null, 150000, 250000, 30),
  ('tata-nexon-new', 'Tata Nexon (New)', 'Tata', 'Nexon', 'compact_suv', 'suv', 5, 'petrol', 'manual', 'New model', 200000, 280000, 40),
  ('tata-nexon-old', 'Tata Nexon (Old)', 'Tata', 'Nexon', 'compact_suv', 'suv', 5, 'petrol', 'manual', null, 170000, 250000, 50),
  ('maruti-victoris-cng', 'Victoris CNG', 'Maruti Suzuki', 'Victoris', 'suv', 'suv', 5, 'cng', 'manual', null, 180000, 300000, 60),
  ('tata-punch-cng', 'Tata Punch CNG', 'Tata', 'Punch', 'micro_suv', 'suv', 5, 'cng', 'manual', 'Best value', 150000, 230000, 70),
  ('hyundai-i20', 'Hyundai i20', 'Hyundai', 'i20', 'hatchback', 'hatch', 5, 'petrol', 'manual', null, 150000, 250000, 80),
  ('maruti-baleno', 'Maruti Baleno', 'Maruti Suzuki', 'Baleno', 'hatchback', 'hatch', 5, 'petrol', 'manual', null, 130000, 250000, 90),
  ('maruti-ertiga', 'Ertiga (7 Seater)', 'Maruti Suzuki', 'Ertiga', 'mpv', 'mpv', 7, 'petrol', 'manual', '7 seater', 200000, 350000, 100),
  ('maruti-xl6-cng', 'XL6 CNG', 'Maruti Suzuki', 'XL6', 'premium_mpv', 'mpv', 6, 'cng', 'manual', null, 200000, 350000, 110)
on conflict (slug) do nothing;
