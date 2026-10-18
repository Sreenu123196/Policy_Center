import { useEffect, useState } from 'react';
import type { Api, ClaimView } from './api.js';
import { ErrorList } from './ErrorList.js';
import { formatDate, sentence } from './format.js';

const STATUSES = ['submitted', 'under_review', 'documents_pending', 'approved', 'settled', 'rejected', 'closed'];

// The claims the user may see. A claim reported late, or on a policy that could not be verified for the loss date, is
// flagged, so a handler looks at it first (document section 15).
export function ClaimList({ api }: { api: Api }) {
  const [claims, setClaims] = useState<ClaimView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let current = true;
    api
      .listClaims()
      .then((page) => current && setClaims(page.items))
      .catch((caught: unknown) => current && setError(caught));
    return () => {
      current = false;
    };
  }, [api]);

  if (error !== null) return <ErrorList error={error} />;
  if (claims === null) return <p>Loading...</p>;

  const words = search.trim().toLowerCase();
  const shown = claims.filter(
    (c) => (status === '' || c.status === status) && (words === '' || c.claimNumber.toLowerCase().includes(words) || c.policyNumber.toLowerCase().includes(words)),
  );

  return (
    <section>
      <h2>Claims</h2>
      <div className="form">
        <label>
          Search by claim or policy number
          <input value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {sentence(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="muted">No claim matches</p>
      ) : (
        <table aria-label="Claims">
          <thead>
            <tr>
              <th>Claim</th>
              <th>Policy</th>
              <th>Loss date</th>
              <th>Cause</th>
              <th>Status</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((claim) => (
              <tr key={claim.claimNumber}>
                <td>
                  <a href={`#/claim/${claim.claimNumber}`}>{claim.claimNumber}</a>
                </td>
                <td>
                  <a href={`#/policy/${claim.policyNumber}`}>{claim.policyNumber}</a>
                </td>
                <td>{formatDate(claim.lossDate)}</td>
                <td>{claim.cause.replace(/_/g, ' ')}</td>
                <td>{sentence(claim.status)}</td>
                <td>
                  {claim.lateReport && <span className="warning">Reported late</span>}
                  {claim.lateReport && claim.verification !== 'verified' && ' '}
                  {claim.verification !== 'verified' && <span className="warning">{sentence(claim.verification)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
