import type { AppRole } from '@shared/constants.ts';
import { expiryState } from '@shared/documents.ts';
import { istDateIso } from '@shared/time.ts';
import { looksLikeFullAadhaar } from '@shared/validation.ts';
import type { DocumentRow, DocumentType } from '@/types/db';

export { ACCEPT_ATTR, formatBytes } from '@shared/documents.ts';
export const looksLikeFullAadhaarNumber = looksLikeFullAadhaar;

/** Can this role download files of this type? Staff never download KYC (2.2). */
export function canDownloadType(type: DocumentType | undefined, role: AppRole | null): boolean {
  if (!type || !role) return false;
  if (role === 'staff' && type.is_kyc) return false;
  return type.download_roles.includes(role);
}

export const docExpiryState = (doc: Pick<DocumentRow, 'expiry_date'>) => expiryState(doc.expiry_date, istDateIso());

/** Latest non-superseded version per type, plus older versions grouped by type. */
export function splitVersions(docs: DocumentRow[]) {
  const current = docs.filter((d) => d.status !== 'superseded');
  const history = docs.filter((d) => d.status === 'superseded');
  return { current, history };
}

export const isImage = (mime: string) => mime.startsWith('image/');
