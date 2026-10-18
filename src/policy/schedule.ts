import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { addDays } from '../platform/index.js';

// The policy schedule (document section 11): the page that says what is insured, for how long, and for how much.
// The text is built first as plain lines (easy to test), then drawn on a PDF page. Standard PDF fonts have no Hindi or
// Telugu letters, so this first version is in English; translated templates need embedded fonts and come later.

export interface ScheduleData {
  policyNumber: string;
  jobNumber: string;
  version: number;
  productName: string;
  rateBook: string;
  periodStart: string; // yyyy-mm-dd
  periodEnd: string; // exclusive
  issuedOn: string;
  producerCode: string;
  insured: { name: string; addressLines: string[] };
  vehicle: { description: string; registrationNumber: string };
  coverages: { name: string; detail: string; premiumPaise: number }[];
  premiumPaise: number;
  taxName: string;
  taxPaise: number;
  totalPaise: number;
  conditions: string[]; // conditions attached to underwriting approvals
  change?: { effectiveDate: string; premiumChangePaise: number; totalChangePaise: number }; // set for an endorsement
}

// Whole paise to rupees with Indian digit grouping: 123456789 paise is Rs 12,34,567.89.
export function formatRupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${sign}Rs ${grouped}.${String(abs % 100).padStart(2, '0')}`;
}

// Documents show dates as DD-MM-YYYY; the database keeps yyyy-mm-dd.
export const formatDate = (date: string): string => `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;

export function buildScheduleLines(data: ScheduleData): string[] {
  const lines = [
    data.change ? 'Endorsement schedule' : 'Policy schedule',
    data.productName,
    '',
    `Policy number: ${data.policyNumber}`,
    `Version: ${data.version}`,
    `Job: ${data.jobNumber}`,
    `Issued on: ${formatDate(data.issuedOn)}`,
    `Period: ${formatDate(data.periodStart)} to ${formatDate(data.periodEnd)} (the last day of cover is ${formatDate(addDays(data.periodEnd, -1))})`,
    `Producer code: ${data.producerCode}`,
    '',
    'Insured',
    data.insured.name,
    ...data.insured.addressLines,
    '',
    'Vehicle',
    `${data.vehicle.description}, registration ${data.vehicle.registrationNumber}`,
    '',
    'Cover and premium',
    ...data.coverages.map((c) => `${c.name}${c.detail === '' ? '' : ` (${c.detail})`}: ${formatRupees(c.premiumPaise)}`),
    `Total premium: ${formatRupees(data.premiumPaise)}`,
    `${data.taxName}: ${formatRupees(data.taxPaise)}`,
    `Total payable: ${formatRupees(data.totalPaise)}`,
    `Rate book: ${data.rateBook}`,
  ];
  if (data.change) {
    lines.splice(8, 0, `Change effective from: ${formatDate(data.change.effectiveDate)}`, `Premium change: ${formatRupees(data.change.premiumChangePaise)} (with tax ${formatRupees(data.change.totalChangePaise)})`);
  }
  if (data.conditions.length > 0) lines.push('', 'Conditions', ...data.conditions);
  return lines;
}

const HEADINGS = new Set(['Policy schedule', 'Endorsement schedule', 'Insured', 'Vehicle', 'Cover and premium', 'Conditions']);

// Draws the lines on A4 pages and returns the PDF file. The creation date is the issue date, so the same data gives the same file.
export async function renderSchedulePdf(data: ScheduleData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${data.change ? 'Endorsement' : 'Policy'} schedule ${data.policyNumber}`);
  pdf.setSubject(`Policy ${data.policyNumber}, version ${data.version}, job ${data.jobNumber}`);
  pdf.setProducer('Insurance Suite');
  pdf.setCreator('Insurance Suite');
  pdf.setCreationDate(new Date(`${data.issuedOn}T00:00:00Z`));
  pdf.setModificationDate(new Date(`${data.issuedOn}T00:00:00Z`));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const margin = 50;
  const lineHeight = 16;
  let page = pdf.addPage([595, 842]);
  let y = 842 - margin;
  for (const line of buildScheduleLines(data)) {
    if (y < margin) {
      page = pdf.addPage([595, 842]);
      y = 842 - margin;
    }
    const heading = HEADINGS.has(line);
    if (line !== '') page.drawText(line, { x: margin, y, size: line.endsWith(' schedule') ? 20 : heading ? 13 : 11, font: heading ? bold : regular, color: rgb(0, 0, 0) });
    y -= line.endsWith(' schedule') ? 28 : lineHeight;
  }
  return pdf.save();
}
