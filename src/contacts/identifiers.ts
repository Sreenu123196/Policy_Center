// Checks and masks for Indian identifiers (document section 16).
// These are pure functions: they never touch the database, so they are easy to test.
// They check the FORMAT only. Checking that a PIN code or a PAN really exists needs an outside
// service, which the document places behind an integration adapter (section 17).

type Kind = 'person' | 'company';

// An Indian PIN code is six digits and never starts with 0.
export const isValidPinCode = (pin: string): boolean => /^[1-9][0-9]{5}$/.test(pin);

// PAN: five letters, four digits, one letter. The fourth letter says who holds it:
// P is an individual; other letters are companies, firms, trusts and so on.
export function isValidPan(pan: string, kind: Kind): boolean {
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return false;
  const holderType = pan.charAt(3);
  return kind === 'person' ? holderType === 'P' : holderType !== 'P';
}

// Shown as ABCPK****D: enough to recognise, not enough to misuse.
export const maskPan = (pan: string): string => `${pan.slice(0, 5)}****${pan.slice(9)}`;

// GSTIN: two-digit state code (01 to 38), the holder's PAN, an entity number, the letter Z,
// and a check character. We check the shape, not the check character.
export const isValidGstin = (gstin: string): boolean =>
  /^(0[1-9]|[12][0-9]|3[0-8])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin);

// Aadhaar must never be stored in full. This keeps only the last four digits.
// An Aadhaar number has 12 digits and does not start with 0 or 1.
export function maskAadhaar(raw: string): string {
  const digits = raw.replace(/\s/g, '');
  if (!/^[0-9]{12}$/.test(digits)) throw new Error('Aadhaar must be 12 digits');
  if (/^[01]/.test(digits)) throw new Error('Aadhaar cannot start with 0 or 1');
  return `XXXX XXXX ${digits.slice(8)}`;
}

// An Indian mobile number is ten digits starting with 6 to 9. Stored in one standard form (+91...)
// so the same number is never saved in several ways. Returns null if it is not a valid number.
export function normalisePhone(raw: string): string | null {
  const compact = raw.replace(/[\s-]/g, '');
  const match = /^(?:\+91|91|0)?([6-9][0-9]{9})$/.exec(compact);
  return match ? `+91${match[1]}` : null;
}

export const isValidEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
