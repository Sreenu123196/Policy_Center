// Records are identified by a UUID. Checking the shape first lets us answer "not found" for a
// malformed id, instead of letting the database raise an error.
export const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
