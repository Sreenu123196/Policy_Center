'use strict';
// Monthly profitability and settlement report, for UW managers only.
//
//   Income   = premiums written in the month (net of returns) + commission on those premiums
//   Expenses = salaries, office rent and other costs entered in the app
//   Net profit = income - expenses
//
// Premium is billed premium by the month of each invoice's due date, net of credits for returns.
// Commission is one rate applied to that premium (UW Manager sets it; 15% until changed).

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { AppError } = require('./policyCenter');
const { canSeeBillingReport } = require('./permissions');
const { round2 } = require('./rating');

const EXPENSE_CATEGORIES = ['Salaries', 'Office rent', 'Other costs'];
const DEFAULT_COMMISSION_RATE = 0.15;
const MAX_MONTHS = 36;

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > MAX_MONTHS) throw new AppError(422, `Choose at most ${MAX_MONTHS} months`);
  }
  return out;
}

class Finance {
  constructor(pc) {
    this.pc = pc;
    if (!pc.db.finance) pc.db.finance = { commissionRate: null, expenses: [] };
  }

  requireAccess(user) {
    if (!canSeeBillingReport(user)) throw new AppError(403, 'Financial reports are for UW managers');
  }

  commissionRate() {
    const r = this.pc.db.finance.commissionRate;
    return r === null || r === undefined ? DEFAULT_COMMISSION_RATE : r;
  }

  setCommissionRate(user, percent) {
    this.requireAccess(user);
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new AppError(422, 'Commission must be between 0 and 100 percent');
    this.pc.db.finance.commissionRate = round2(value) / 100;
    return { commissionRatePercent: round2(value) };
  }

  addExpense(user, { month, category, amount, note }) {
    this.requireAccess(user);
    if (!isMonth(month)) throw new AppError(422, 'Month must be in the form 2026-10');
    if (!EXPENSE_CATEGORIES.includes(category)) throw new AppError(422, `Category must be one of ${EXPENSE_CATEGORIES.join(', ')}`);
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new AppError(422, 'Amount must be more than zero');
    const entry = {
      id: this.pc.store.id('exp'), month, category, amount: round2(value), note: String(note || '').trim(),
      createdBy: user.id, createdByName: user.name, createdAt: this.pc.now(),
    };
    this.pc.db.finance.expenses.push(entry);
    return entry;
  }

  expenses(user, { from, to } = {}) {
    this.requireAccess(user);
    return this.pc.db.finance.expenses
      .filter((e) => (!from || e.month >= from) && (!to || e.month <= to))
      .sort((a, b) => b.month.localeCompare(a.month) || a.category.localeCompare(b.category));
  }

  // Month-by-month figures for the range (both months included).
  // Without a range, the report covers the last 12 months up to the current month.
  report(user, range = {}) {
    this.requireAccess(user);
    const to = range.to || this.pc.today().slice(0, 7);
    const from = range.from || addMonths(to, -11);
    if (!isMonth(from) || !isMonth(to)) throw new AppError(422, 'From and to must be months, for example 2026-01');
    if (from > to) throw new AppError(422, 'The first month is after the last month');
    const months = monthsBetween(from, to);
    const premium = Object.fromEntries(months.map((m) => [m, 0]));
    // Premium is what billing charges in the month (invoice due date); credits for returns reduce it.
    for (const i of this.pc.db.invoices) {
      const m = String(i.dueDate || '').slice(0, 7);
      if (m in premium) premium[m] = round2(premium[m] + i.amount);
    }
    const rate = this.commissionRate();
    const rows = months.map((month) => {
      const prem = premium[month];
      const commission = round2(prem * rate);
      const byCategory = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, 0]));
      for (const e of this.pc.db.finance.expenses) if (e.month === month) byCategory[e.category] = round2(byCategory[e.category] + e.amount);
      const totalExpenses = round2(Object.values(byCategory).reduce((s, v) => s + v, 0));
      const income = round2(prem + commission);
      return { month, premium: prem, commission, income, expenses: byCategory, totalExpenses, net: round2(income - totalExpenses) };
    });
    const sum = (key) => round2(rows.reduce((s, r) => s + r[key], 0));
    const totals = {
      premium: sum('premium'), commission: sum('commission'), income: sum('income'), totalExpenses: sum('totalExpenses'), net: sum('net'),
      expenses: Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, round2(rows.reduce((s, r) => s + r.expenses[c], 0))])),
    };
    return { from, to, commissionRatePercent: round2(rate * 100), categories: EXPENSE_CATEGORIES, months: rows, totals, generatedOn: this.pc.today() };
  }

  // Excel workbook: monthly figures plus the expense entries behind them.
  async excel(user, range) {
    const r = this.report(user, range);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'PolicyCenter';
    const ws = wb.addWorksheet('Monthly settlement');
    ws.columns = [
      { header: 'Month', key: 'month', width: 12 },
      { header: 'Premium', key: 'premium', width: 16 },
      { header: `Commission (${r.commissionRatePercent}%)`, key: 'commission', width: 18 },
      { header: 'Income', key: 'income', width: 14 },
      ...r.categories.map((c) => ({ header: c, key: c, width: 14 })),
      { header: 'Total expenses', key: 'totalExpenses', width: 16 },
      { header: 'Net profit', key: 'net', width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const m of r.months) {
      ws.addRow({ month: m.month, premium: m.premium, commission: m.commission, income: m.income, ...m.expenses, totalExpenses: m.totalExpenses, net: m.net });
    }
    ws.addRow({ month: 'Total', premium: r.totals.premium, commission: r.totals.commission, income: r.totals.income, ...r.totals.expenses, totalExpenses: r.totals.totalExpenses, net: r.totals.net }).font = { bold: true };
    ws.eachRow((row, n) => { if (n > 1) row.eachCell((cell, col) => { if (col > 1) cell.numFmt = '#,##0.00'; }); });
    const ex = wb.addWorksheet('Expenses');
    ex.columns = [{ header: 'Month', key: 'month', width: 12 }, { header: 'Category', key: 'category', width: 16 }, { header: 'Amount', key: 'amount', width: 14 }, { header: 'Note', key: 'note', width: 40 }, { header: 'Entered by', key: 'createdByName', width: 20 }];
    ex.getRow(1).font = { bold: true };
    for (const e of this.expenses(user, { from: r.from, to: r.to })) ex.addRow(e);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // PDF summary: the same figures, for sharing.
  pdf(user, range) {
    const r = this.report(user, range);
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.font('Helvetica-Bold').fontSize(16).text('PolicyCenter: monthly settlement report');
      doc.font('Helvetica').fontSize(10).text(`Months ${r.from} to ${r.to} · commission ${r.commissionRatePercent}% of premium · prepared ${r.generatedOn}`);
      doc.moveDown();
      const cols = ['Month', 'Premium', 'Commission', 'Income', ...r.categories, 'Expenses', 'Net profit'];
      const widths = [48, 62, 62, 62, 62, 62, 52, 62];
      const line = (values, bold = false) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        let x = 40;
        const y = doc.y;
        values.forEach((v, i) => {
          doc.text(String(v), x, y, { width: widths[i] - 4, align: i === 0 ? 'left' : 'right' });
          x += widths[i];
        });
        doc.moveDown(0.6);
      };
      line(cols, true);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.4);
      const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      for (const m of r.months) {
        line([m.month, money(m.premium), money(m.commission), money(m.income), ...r.categories.map((c) => money(m.expenses[c])), money(m.totalExpenses), money(m.net)]);
      }
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.4);
      line(['Total', money(r.totals.premium), money(r.totals.commission), money(r.totals.income), ...r.categories.map((c) => money(r.totals.expenses[c])), money(r.totals.totalExpenses), money(r.totals.net)], true);
      doc.moveDown();
      doc.font('Helvetica').fontSize(8).fillColor('#555').text('Premium is the billed premium due in each month, net of credits for returns. Commission is the set percentage of that premium. Net profit = income minus expenses.');
      doc.end();
    });
  }
}

module.exports = { Finance, EXPENSE_CATEGORIES, DEFAULT_COMMISSION_RATE, monthsBetween };
