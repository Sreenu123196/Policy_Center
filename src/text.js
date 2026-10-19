'use strict';
// Small value helpers shared by the service modules: text, numbers and a JSON copy.

const clone = (o) => JSON.parse(JSON.stringify(o));
const str = (v) => (v == null ? '' : String(v).trim());
const int = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r100 = (n) => Math.round(n / 100) * 100;

module.exports = { clone, str, int, num, r100 };
