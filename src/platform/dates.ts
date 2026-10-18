// True for a real calendar date written as yyyy-mm-dd, such as 2026-02-28.
// JavaScript quietly "rolls over" some wrong dates (2026-02-30 becomes 2 March) and refuses others
// (2026-13-45), so we check both: the text must parse, and turn back into exactly the same text.
export function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

const assertRealDate = (text: string): void => {
  if (!isRealDate(text)) throw new Error(`${text} is not a real date (write it as yyyy-mm-dd)`);
};

// The same day, some years later. An annual policy ends on the anniversary of its start (the end day is excluded).
// 29 February in a year that has no 29 February becomes 1 March.
export function addYears(text: string, years: number): string {
  assertRealDate(text);
  const [year, month, day] = text.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year + years, month - 1, day));
  if (moved.getUTCMonth() !== month - 1) return new Date(Date.UTC(year + years, month, 1)).toISOString().slice(0, 10);
  return moved.toISOString().slice(0, 10);
}

// The date some days later (or earlier, with a negative number).
export function addDays(text: string, days: number): string {
  assertRealDate(text);
  const moved = new Date(`${text}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}
