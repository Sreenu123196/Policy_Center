'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { settlementPacket, buildChronology, valueItems, toPaise } = require('../src/medicalChronology');

// A chronology is ordered and sourced; money is exact. The tests are mostly about the second, because arithmetic errors are silent.

const EVENTS = [
  { date: '2026-03-20', description: 'Discharged after five days', source: 'hospital-discharge', provider: 'City Hospital' },
  { date: '2026-03-15', description: 'Admitted with a fractured wrist', source: 'admission-record', provider: 'City Hospital' },
  { date: '2026-03-16', description: 'Surgery on the wrist', source: 'operation-note' },
];

test('events are ordered, with days from the first entry and their source', () => {
  const chronology = buildChronology(EVENTS);
  assert.deepEqual(chronology.map((e) => e.date), ['2026-03-15', '2026-03-16', '2026-03-20']);
  assert.deepEqual(chronology.map((e) => e.daysFromFirst), [0, 1, 5]);
  assert.equal(chronology[0].source, 'admission-record');
});

test('an event with an unreadable date or no description is refused, not skipped', () => {
  assert.throws(() => buildChronology([{ date: 'sometime in March', description: 'x' }]), /no readable date/);
  assert.throws(() => buildChronology([{ date: '2026-03-15' }]), /no description/);
});

test('money is exact: the classic float sum does not drift', () => {
  const totals = valueItems([
    { category: 'medical', amount: 0.1 },
    { category: 'medical', amount: 0.2 },
    { category: 'transportation', amount: 0.7 },
  ]);
  assert.equal(totals.medical, 30, '0.1 + 0.2 is 30 paise, not 30.000000000000004');
  assert.equal(totals.transportation, 70);
  assert.equal(totals.total, 100);
});

test('a negative amount or a third decimal place is refused', () => {
  assert.throws(() => toPaise(-1), /non-negative/);
  assert.throws(() => toPaise(1.234), /two decimal places/);
  assert.throws(() => valueItems([{ category: 'gifts', amount: 10 }]), /unknown category/);
});

test('a packet totals the categories and compares them with the reserve', () => {
  const packet = settlementPacket({
    claimNumber: 'CL-0000001',
    events: EVENTS,
    items: [
      { category: 'medical', amount: 125000 },
      { category: 'lossOfIncome', amount: 30000 },
      { category: 'transportation', amount: 5000 },
    ],
    reserve: 150000,
  });
  assert.equal(packet.totals.medical, 12500000);
  assert.equal(packet.totals.total, 16000000);
  assert.equal(packet.reservePaise, 15000000);
  assert.equal(packet.variancePaise, 1000000, 'the demand exceeds the reserve by 10,000 rupees');
  assert.match(packet.note, /exceeds the reserve/);
});

test('without a reserve the packet says so rather than implying zero', () => {
  const packet = settlementPacket({ claimNumber: 'CL-2', items: [{ category: 'medical', amount: 100 }] });
  assert.equal(packet.reservePaise, null);
  assert.equal(packet.variancePaise, null);
  assert.match(packet.note, /No reserve is recorded/);
});
