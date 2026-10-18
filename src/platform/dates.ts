// True for a real calendar date written as yyyy-mm-dd, such as 2026-02-28.
// JavaScript quietly "rolls over" some wrong dates (2026-02-30 becomes 2 March) and refuses others
// (2026-13-45), so we check both: the text must parse, and turn back into exactly the same text.
export function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}
