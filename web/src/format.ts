// How money and dates are shown on screen (CLAUDE.md): rupees with Indian digit grouping, dates as DD-MM-YYYY.
// The database and the API keep whole paise and yyyy-mm-dd.

export function formatRupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${sign}Rs ${grouped}.${String(abs % 100).padStart(2, '0')}`;
}

export const formatDate = (date: string): string => `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;

// Whole rupees typed by a person (for example "5,00,000") to paise, or null if it is not a number.
export function rupeesToPaise(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

// A code from the API such as under_review, as a sentence for a person: "Under review".
export const sentence = (code: string): string => {
  const words = code.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
