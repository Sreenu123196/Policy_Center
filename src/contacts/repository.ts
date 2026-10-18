import type { PGlite } from '@electric-sql/pglite';
import { isUuid, ValidationError } from '../platform/index.js';
import { tidy, validateNewContact, type Contact, type ContactKind, type NewContact } from './contact.js';
import { maskAadhaar, maskPan, normalisePhone } from './identifiers.js';

interface ContactRow {
  id: string;
  kind: ContactKind;
  name: string;
  date_of_birth: string | null;
  phone: string | null;
  email: string | null;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  pin_code: string;
  pan: string | null;
  gstin: string | null;
  aadhaar_masked: string | null;
  created_by: string;
  created_at: Date;
}

// The date is read back as text (yyyy-mm-dd), so time zones can never shift a birth date by a day.
const SELECT_CONTACT = `
  select id, kind, name, to_char(date_of_birth, 'YYYY-MM-DD') as date_of_birth, phone, email,
         address_line1, address_line2, city, state, pin_code, pan, gstin, aadhaar_masked, created_by, created_at
    from contacts.contact`;

// The PAN stays in full in the database (tax uses need it) but leaves this module masked.
const toContact = (row: ContactRow): Contact => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  dateOfBirth: row.date_of_birth,
  phone: row.phone,
  email: row.email,
  address: { line1: row.address_line1, line2: row.address_line2, city: row.city, state: row.state, pinCode: row.pin_code },
  panMasked: row.pan ? maskPan(row.pan) : null,
  gstin: row.gstin,
  aadhaarMasked: row.aadhaar_masked,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

// Saves a person or company. Throws ValidationError, listing every problem, if the input is not acceptable.
// `actor` is the person or agent making the change; the audit log (step C3) will record it too.
export async function createContact(db: PGlite, input: NewContact, actor: string): Promise<Contact> {
  const contact = tidy(input);
  const errors = validateNewContact(contact);
  if (errors.length > 0) throw new ValidationError(errors);

  const inserted = await db.query<{ id: string }>(
    `insert into contacts.contact
       (kind, name, date_of_birth, phone, email, address_line1, address_line2, city, state, pin_code,
        pan, gstin, aadhaar_masked, created_by)
     values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [
      contact.kind,
      contact.name,
      contact.dateOfBirth ?? null,
      contact.phone ? normalisePhone(contact.phone) : null,
      contact.email ?? null,
      contact.address.line1,
      contact.address.line2 ?? null,
      contact.address.city,
      contact.address.state,
      contact.address.pinCode,
      contact.pan ?? null,
      contact.gstin ?? null,
      // The full Aadhaar number is masked here and goes no further.
      contact.aadhaar ? maskAadhaar(contact.aadhaar) : null,
      actor,
    ],
  );

  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('The contact was not saved');
  const saved = await getContact(db, id);
  if (saved === null) throw new Error('The contact was saved but could not be read back');
  return saved;
}

// Finds a contact by id, or returns null if there is none.
export async function getContact(db: PGlite, id: string): Promise<Contact | null> {
  if (!isUuid(id)) return null; // a malformed id cannot match anything
  const result = await db.query<ContactRow>(`${SELECT_CONTACT} where id = $1`, [id]);
  const row = result.rows[0];
  return row ? toContact(row) : null;
}
