'use strict';
// ISO (yyyy-mm-dd) date helpers. All math is done in UTC so day counts are exact.

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

function parse(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}

const isDate = (s) => parse(s) !== null;
const fmt = (dt) => dt.toISOString().slice(0, 10);
const addDays = (s, n) => fmt(new Date(parse(s).getTime() + n * DAY_MS));
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY_MS);
const yearOf = (s) => parse(s).getUTCFullYear();
const maxDate = (a, b) => (a > b ? a : b);

function addMonths(s, n) {
  const d = parse(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return fmt(d);
}

function ageOn(dob, onDate) {
  const b = parse(dob);
  const o = parse(onDate);
  if (!b || !o) return null;
  let age = o.getUTCFullYear() - b.getUTCFullYear();
  const md = o.getUTCMonth() - b.getUTCMonth();
  if (md < 0 || (md === 0 && o.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

function todayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

module.exports = { parse, isDate, addDays, addMonths, daysBetween, ageOn, yearOf, maxDate, todayISO };
