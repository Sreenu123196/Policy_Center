import { isRealDate } from '../platform/index.js';
import { isValidEmail, isValidGstin, isValidPan, isValidPinCode, maskAadhaar, normalisePhone } from './identifiers.js';

export type ContactKind = 'person' | 'company';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pinCode: string;
}

// What the caller gives us. The Aadhaar is accepted here only so it can be masked; it is never stored in full.
export interface NewContact {
  kind: ContactKind;
  name: string; // a person's full name, or a company's legal name
  dateOfBirth?: string; // people only, as yyyy-mm-dd
  phone?: string;
  email?: string;
  address: Address;
  pan?: string;
  gstin?: string; // companies only
  aadhaar?: string; // people only
}

// What we give back: identifiers are masked, and dates are plain yyyy-mm-dd or ISO text.
export interface Contact {
  id: string;
  kind: ContactKind;
  name: string;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  address: { line1: string; line2: string | null; city: string; state: string; pinCode: string };
  panMasked: string | null;
  gstin: string | null;
  aadhaarMasked: string | null;
  createdBy: string;
  createdAt: string;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// Tidies input before checking it: trims spaces, drops empty optional fields, and writes PAN and GSTIN
// in capital letters, so "abcpk1234d" and " ABCPK1234D " are the same PAN.
export function tidy(input: NewContact): NewContact {
  return {
    kind: input.kind,
    name: input.name.trim(),
    dateOfBirth: clean(input.dateOfBirth),
    phone: clean(input.phone),
    email: clean(input.email),
    address: {
      line1: input.address.line1.trim(),
      line2: clean(input.address.line2),
      city: input.address.city.trim(),
      state: input.address.state.trim(),
      pinCode: input.address.pinCode.trim(),
    },
    pan: clean(input.pan)?.toUpperCase(),
    gstin: clean(input.gstin)?.toUpperCase(),
    aadhaar: clean(input.aadhaar),
  };
}

// Returns every problem with a tidied contact. An empty list means it is acceptable.
export function validateNewContact(contact: NewContact, today: string = new Date().toISOString().slice(0, 10)): string[] {
  const errors: string[] = [];
  const { kind, address } = contact;

  if (kind !== 'person' && kind !== 'company') errors.push('Kind must be person or company');
  if (!contact.name) errors.push('Name is required');
  else if (contact.name.length > 200) errors.push('Name is too long (200 characters at most)');

  if (!address.line1) errors.push('Address line 1 is required');
  if (!address.city) errors.push('City is required');
  if (!address.state) errors.push('State is required');
  if (!isValidPinCode(address.pinCode)) errors.push('PIN code must be 6 digits and cannot start with 0');

  if (contact.phone !== undefined && normalisePhone(contact.phone) === null) {
    errors.push('Phone must be a 10-digit Indian mobile number starting with 6 to 9');
  }
  if (contact.email !== undefined && !isValidEmail(contact.email)) errors.push('Email address is not valid');
  if (contact.pan !== undefined && !isValidPan(contact.pan, kind === 'company' ? 'company' : 'person')) {
    errors.push(`PAN is not valid for a ${kind === 'company' ? 'company' : 'person'} (a person's PAN has P as its fourth letter)`);
  }

  if (kind === 'person') {
    if (contact.gstin !== undefined) errors.push('A person cannot have a GSTIN');
    if (contact.dateOfBirth !== undefined) {
      if (!isRealDate(contact.dateOfBirth)) errors.push('Date of birth must be a real date written as yyyy-mm-dd');
      else if (contact.dateOfBirth > today) errors.push('Date of birth cannot be in the future');
    }
    if (contact.aadhaar !== undefined) {
      try {
        maskAadhaar(contact.aadhaar);
      } catch (error) {
        errors.push(`Aadhaar is not valid: ${(error as Error).message}`);
      }
    }
  }

  if (kind === 'company') {
    if (contact.dateOfBirth !== undefined) errors.push('A company cannot have a date of birth');
    if (contact.aadhaar !== undefined) errors.push('A company cannot have an Aadhaar number');
    if (contact.gstin !== undefined && !isValidGstin(contact.gstin)) errors.push('GSTIN is not valid');
  }

  return errors;
}
