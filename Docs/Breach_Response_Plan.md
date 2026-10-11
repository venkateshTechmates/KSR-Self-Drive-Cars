# KSR Self Drive Cars — Personal data breach response plan

_Draft for review by the Owner and a legal/compliance adviser (PRD DP-06). Not legal advice.
Confirm the notification deadlines and content against the DPDP Rules, 2025 before relying on this plan._

## 1. What counts as a breach

Any unauthorised access to, or loss, disclosure, change or destruction of, personal data we hold. For example:

- someone outside KSR sees customer licence or Aadhaar images;
- a staff phone with an active admin session is lost or stolen;
- an admin account is used by someone other than its owner;
- documents are deleted or changed without authority;
- personal data is emailed or shared with the wrong person.

## 2. Who decides

| Role | Person | Contact |
|---|---|---|
| Breach lead (decides and coordinates) | [Owner name] | [phone, email] |
| Deputy | [Manager name] | [phone, email] |
| Technical support | [Developer / agency] | [phone, email] |
| Legal / compliance adviser | [Name] | [phone, email] |

Anyone who suspects a breach tells the breach lead **immediately**, by phone.

## 3. First hour: contain

1. **Lost or stolen phone, or a suspect account:** in `/admin/staff`, deactivate the account. This ends its sessions straight away, and the database refuses its requests.
2. **Leaked password:** reset it, and check two-step verification is on.
3. **Wider compromise:** in Supabase, rotate the service-role key and the `CRON_SECRET` / `RATE_LIMIT_SALT` function secrets, and redeploy the edge functions.
4. Do not delete evidence. Note the time you found the problem and what you did.

## 4. First day: assess

Use the admin audit log (`/admin/audit`) to establish:

- which accounts were involved (filter by user and date);
- which documents were viewed or downloaded (`document.view`, `document.download`);
- which records were changed or exported (`*.update`, `customer.export`, `*.export`);
- which customers are affected, and what kind of data (name, mobile, licence, masked Aadhaar, photos, payments).

Record the findings in the incident log (section 7).

## 5. Tell the people who need to know

| Who | When | How | What |
|---|---|---|---|
| Data Protection Board of India | Within the time the DPDP Rules set [confirm with adviser] | As the Board prescribes | Nature, extent, timing and likely impact of the breach; what we have done |
| Affected customers | Without delay [confirm with adviser] | Phone or WhatsApp, followed by email or SMS | What happened, what data, likely impact, what we are doing, what they can do, and our contact |
| Police | If a crime is suspected (theft, fraud) | Local station / cyber cell | Facts and evidence |
| Insurer | If business insurance covers cyber incidents | As per policy | As required |

**Customer message template** (adapt per incident):

> We're writing to tell you about a problem with personal data held by KSR Self Drive Cars. On [date], [what happened]. This involved your [types of data]. We have [actions taken]. You may want to [steps, e.g. watch for misuse of your licence number]. If you have questions, contact [grievance officer, phone, email].

## 6. Recover and learn

- Fix the cause (for example, enforce screen locks on staff phones, remove an unused account, tighten a setting).
- Check whether retention periods or access rules should change.
- Brief all staff on what happened and what changes.

## 7. Incident log

Keep a record for every incident, including ones that turn out not to be breaches:

| Field | Entry |
|---|---|
| Date and time found | |
| Found by | |
| What happened | |
| Data and customers affected | |
| Containment steps and times | |
| Board notified (date, reference) | |
| Customers notified (date, how) | |
| Root cause | |
| Changes made | |
| Closed by and date | |

## 8. Review

Review this plan once a year, and after any incident. Test the containment steps (deactivating an account, rotating keys) once a year.
