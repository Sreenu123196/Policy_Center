'use strict';
// Billing rules: GST and commission.
//
// Both are policy, so both are data. When finance gives real rates this becomes a configuration change and a test, not a
// rewrite. The rounding rule matters as much as the rate: money is computed to paise, half-up, at the point of posting.

const GST_RATE = 0.18; // general insurance premium

// Commission by premium band, on the net premium. The band is chosen by the premium the policy is written at.
const COMMISSION_BANDS = [
  { upTo: 10000, rate: 0.15, label: 'up to 10,000' },
  { upTo: 50000, rate: 0.125, label: '10,000 to 50,000' },
  { upTo: null, rate: 0.10, label: 'above 50,000' },
];

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * Split a premium into net and GST. `gross` is the number quoted to the customer.
 * @param {{amount: number, rate?: number}} input
 */
function gstOnPremium({ amount, rate = GST_RATE }) {
  const gross = Number(amount);
  if (!Number.isFinite(gross) || gross < 0) throw new Error('amount must be a non-negative number');
  if (typeof rate !== 'number' || rate < 0 || rate >= 1) throw new Error('rate must be a fraction between 0 and 1');
  const net = round2(gross / (1 + rate));
  const gst = round2(gross - net);
  return { gross, net, gst, rate, ratePercent: round2(rate * 100) };
}

/** The commission band that applies to a net premium, and the commission on it. */
function commissionFor({ premium, bands = COMMISSION_BANDS }) {
  const net = Number(premium);
  if (!Number.isFinite(net) || net < 0) throw new Error('premium must be a non-negative number');
  const band = bands.find((b) => b.upTo === null || net <= b.upTo);
  if (!band) throw new Error('no commission band covers this premium');
  return { band: band.label, rate: band.rate, ratePercent: round2(band.rate * 100), commission: round2(net * band.rate) };
}

module.exports = { gstOnPremium, commissionFor, GST_RATE, COMMISSION_BANDS, round2 };
