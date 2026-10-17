'use strict';
// Insights dashboard for UW managers: policies sold and profit, month by month, sliced by product,
// salesperson (who wrote the sale) and producer code (the agency the account belongs to).
//
// A sale is a policy whose first job was a submission, counted in the month it was bound.
// Premium sold is the bound premium. Profit comes from the monthly settlement (see finance.js).

const { round2 } = require('./rating');

const sumBy = (rows, key) => round2(rows.reduce((s, r) => s + r[key], 0));

// Groups sale rows by a key and returns counts and premium per group, biggest premium first.
function groupSales(rows, keyOf, label) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, { [label]: k, policies: 0, premium: 0 });
    const g = groups.get(k);
    g.policies++;
    g.premium = round2(g.premium + r.premium);
  }
  return [...groups.values()].sort((a, b) => b.premium - a.premium);
}

class Insights {
  constructor(pc, finance) {
    this.pc = pc;
    this.finance = finance;
  }

  dashboard(user, range = {}) {
    // Same access as the settlement report: these figures include profit.
    const fin = this.finance.report(user, range);
    const rate = fin.commissionRatePercent / 100;
    const inRange = new Set(fin.months.map((m) => m.month));
    const sales = this.pc.saleRows(user, {}).filter((r) => inRange.has(r.boundDate.slice(0, 7)));

    const months = fin.months.map((m) => {
      const mine = sales.filter((r) => r.boundDate.slice(0, 7) === m.month);
      const premiumSold = sumBy(mine, 'premium');
      return {
        month: m.month,
        policiesSold: mine.length,
        premiumSold,
        commission: m.commission,
        income: m.income,
        expenses: m.totalExpenses,
        profit: m.net,
        byProduct: groupSales(mine, (r) => r.product, 'product'),
      };
    });

    // Each dimension gets its own totals, with commission earned at the set rate.
    const withCommission = (groups) => groups.map((g) => ({ ...g, commission: round2(g.premium * rate), share: sales.length ? Math.round((g.policies / sales.length) * 1000) / 10 : 0 }));
    const byProduct = withCommission(groupSales(sales, (r) => r.product, 'product'));
    const bySalesperson = withCommission(groupSales(sales, (r) => r.salesperson.name, 'salesperson'));
    const byProducer = withCommission(groupSales(sales, (r) => r.producerCode, 'producer'));

    // Execution view: how many policies each salesperson sold in each month.
    const salespeople = [...new Set(sales.map((r) => r.salesperson.name))].sort();
    const monthsList = fin.months.map((m) => m.month);
    const matrix = salespeople.map((name) => ({
      salesperson: name,
      counts: monthsList.map((m) => sales.filter((r) => r.salesperson.name === name && r.boundDate.slice(0, 7) === m).length),
      total: sales.filter((r) => r.salesperson.name === name).length,
    }));

    return {
      from: fin.from,
      to: fin.to,
      commissionRatePercent: fin.commissionRatePercent,
      totals: {
        policiesSold: sales.length,
        premiumSold: sumBy(sales, 'premium'),
        commission: fin.totals.commission,
        income: fin.totals.income,
        expenses: fin.totals.totalExpenses,
        profit: fin.totals.net,
      },
      months,
      byProduct,
      bySalesperson,
      byProducer,
      matrix: { months: monthsList, rows: matrix },
    };
  }
}

module.exports = { Insights, groupSales };
