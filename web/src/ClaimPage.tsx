import { useEffect, useState } from 'react';
import type { Api, ClaimView, ExposureView, FinancialsView, MoneyView } from './api.js';
import { ErrorList } from './ErrorList.js';
import { formatDate, formatRupees, sentence } from './format.js';

// One claim: what happened, each exposure (one claimant against one cover) with its limit and its money, and the
// totals (document section 15). The money is the server's: incurred = paid + outstanding - recovered. If the money
// cannot be loaded the columns are left out rather than shown as zero.
export function ClaimPage({ api, claimNumber }: { api: Api; claimNumber: string }) {
  const [claim, setClaim] = useState<(ClaimView & { exposures: ExposureView[] }) | null>(null);
  const [claimError, setClaimError] = useState<unknown>(null);
  const [financials, setFinancials] = useState<FinancialsView | null>(null);
  const [financialsError, setFinancialsError] = useState<unknown>(null);

  useEffect(() => {
    let current = true;
    setClaim(null);
    setFinancials(null);
    setClaimError(null);
    setFinancialsError(null);
    api
      .claim(claimNumber)
      .then((loaded) => current && setClaim(loaded))
      .catch((caught: unknown) => current && setClaimError(caught));
    api
      .claimFinancials(claimNumber)
      .then((loaded) => current && setFinancials(loaded))
      .catch((caught: unknown) => current && setFinancialsError(caught));
    return () => {
      current = false;
    };
  }, [api, claimNumber]);

  if (claimError !== null) return <ErrorList error={claimError} />;
  if (claim === null) return <p>Loading...</p>;

  const moneyOf = (number: number) => financials?.exposures.find((e) => e.number === number);
  const cells = (money: MoneyView | undefined) =>
    money ? [money.paidPaise, money.outstandingPaise, money.recoveredPaise, money.incurredPaise].map((paise, i) => <td key={i}>{formatRupees(paise)}</td>) : [0, 1, 2, 3].map((i) => <td key={i}>-</td>);

  return (
    <section className="claim-page">
      <h2>Claim {claim.claimNumber}</h2>
      <p className="status">{sentence(claim.status)}</p>
      <p>
        Policy <a href={`#/policy/${claim.policyNumber}`}>{claim.policyNumber}</a>
      </p>
      <p>{`Loss on ${formatDate(claim.lossDate)} at ${claim.place}, reported ${formatDate(claim.reportedOn)}`}</p>
      <p>{claim.description}</p>
      {claim.lateReport && <p className="warning">This claim was reported late.</p>}
      {claim.verification !== 'verified' && <p className="warning">The policy could not be verified for the loss date; a handler must decide.</p>}

      <h3>Exposures</h3>
      <ErrorList error={financialsError} />
      <table aria-label="Exposures">
        <thead>
          <tr>
            <th>No</th>
            <th>Cover</th>
            <th>Claimant</th>
            <th>Status</th>
            <th>Limit</th>
            <th>Paid</th>
            <th>Outstanding</th>
            <th>Recovered</th>
            <th>Incurred</th>
          </tr>
        </thead>
        <tbody>
          {claim.exposures.map((exposure) => (
            <tr key={exposure.id}>
              <td>{exposure.number}</td>
              <td>{exposure.coverageCode}</td>
              <td>{`${exposure.claimant.name} (${exposure.claimant.kind})`}</td>
              <td>{sentence(exposure.status)}</td>
              <td>{exposure.limitPaise === null ? 'No limit' : formatRupees(exposure.limitPaise)}</td>
              {cells(moneyOf(exposure.number))}
            </tr>
          ))}
        </tbody>
      </table>

      {financials && (
        <div>
          <h3>Totals</h3>
          <table aria-label="Claim totals">
            <thead>
              <tr>
                <th></th>
                <th>Paid</th>
                <th>Outstanding</th>
                <th>Recovered</th>
                <th>Incurred</th>
              </tr>
            </thead>
            <tbody>
              <tr className="total">
                <th>Whole claim</th>
                {cells(financials.claim)}
              </tr>
              {Object.entries(financials.byCostType).map(([type, money]) => (
                <tr key={type}>
                  <th>{sentence(type)}</th>
                  {cells(money)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
