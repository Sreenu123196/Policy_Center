import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildScheduleLines, formatDate, formatRupees, renderSchedulePdf, type ScheduleData } from './schedule.js';

describe('formatting for documents', () => {
  it('writes money in rupees with Indian digit grouping', () => {
    expect(formatRupees(0)).toBe('Rs 0.00');
    expect(formatRupees(5)).toBe('Rs 0.05');
    expect(formatRupees(1858028)).toBe('Rs 18,580.28');
    expect(formatRupees(123456789)).toBe('Rs 12,34,567.89');
    expect(formatRupees(50000000)).toBe('Rs 5,00,000.00');
  });

  it('writes dates as DD-MM-YYYY, as on screens and documents (CLAUDE.md)', () => {
    expect(formatDate('2026-10-15')).toBe('15-10-2026');
  });
});

const data: ScheduleData = {
  policyNumber: 'PL-0000001',
  jobNumber: 'J-0000001',
  version: 1,
  productName: 'Private car insurance',
  rateBook: 'MPC-2026.10',
  periodStart: '2026-10-15',
  periodEnd: '2027-10-15',
  issuedOn: '2026-10-16',
  producerCode: 'PC-100',
  insured: { name: 'Asha Rao', addressLines: ['12 Test Street', 'Hyderabad, Telangana 500081'] },
  vehicle: { description: 'Maruti Swift 2023', registrationNumber: 'TS09XX0001' },
  coverages: [
    { name: 'Third-party liability', detail: '', premiumPaise: 341600 },
    { name: 'Own damage', detail: 'Insured value Rs 5,00,000.00', premiumPaise: 1200000 },
  ],
  premiumPaise: 1541600,
  taxName: 'GST',
  taxPaise: 277488,
  totalPaise: 1819088,
  conditions: ['HIGH_IDV: Garage-kept vehicle only'],
};

describe('the policy schedule (document section 11)', () => {
  it('lists the policy, the insured, the vehicle, each cover with its premium, tax and total', () => {
    const text = buildScheduleLines(data).join('\n');
    expect(text).toContain('Policy schedule');
    expect(text).toContain('Policy number: PL-0000001');
    expect(text).toContain('Version: 1');
    expect(text).toContain('Period: 15-10-2026 to 15-10-2027 (the last day of cover is 14-10-2027)');
    expect(text).toContain('Asha Rao');
    expect(text).toContain('Maruti Swift 2023');
    expect(text).toContain('Third-party liability');
    expect(text).toContain('Rs 3,416.00');
    expect(text).toContain('GST');
    expect(text).toContain('Rs 18,190.88');
    expect(text).toContain('Garage-kept vehicle only');
  });

  it('shows no conditions section when there are none', () => {
    expect(buildScheduleLines({ ...data, conditions: [] }).join('\n')).not.toMatch(/Conditions/);
  });

  it('renders a real PDF with the policy number in its metadata', async () => {
    const bytes = await renderSchedulePdf(data);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(pdf.getTitle()).toBe('Policy schedule PL-0000001');
    expect(pdf.getSubject()).toContain('PL-0000001');
  });

  it('is repeatable: the same data gives the same lines', () => {
    expect(buildScheduleLines(data)).toEqual(buildScheduleLines(data));
  });
});
