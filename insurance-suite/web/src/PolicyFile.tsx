import { useEffect, useState } from 'react';
import type { Api, PolicyAsOfView, PolicyFileView } from './api.js';
import { ErrorList } from './ErrorList.js';
import { formatDate, formatRupees } from './format.js';
import { useAction } from './useAction.js';

// The policy file (document section 20): what an agent or a service person looks at when a customer calls. It shows the
// timeline of versions, what each version changed in premium, the documents and the claims, and lets the person see
// the policy as it was on any date.

const JOB_NAMES: Record<string, string> = {
  submission: 'New business',
  policy_change: 'Policy change',
  cancellation: 'Cancellation',
  reinstatement: 'Reinstatement',
  renewal: 'Renewal',
};

const DOCUMENT_NAMES: Record<string, string> = {
  policy_schedule: 'Policy schedule',
  endorsement_schedule: 'Endorsement schedule',
  cancellation_notice: 'Cancellation notice',
  reinstatement_schedule: 'Reinstatement schedule',
  renewal_schedule: 'Renewal schedule',
  renewal_notice: 'Renewal notice',
  non_renewal_notice: 'Non-renewal notice',
};

const TRANSACTION_NAMES: Record<string, string> = {
  new_business: 'New business',
  change: 'Change',
  cancellation: 'Cancellation (refund)',
  reinstatement: 'Reinstatement',
  renewal: 'Renewal',
};

function describeTerms(terms: Record<string, number | string>): string {
  return Object.entries(terms)
    .map(([name, value]) => {
      if (name === 'idv') return `Insured value ${formatRupees(Number(value))}`;
      if (name === 'vol_deductible') return `Voluntary deductible ${Number(value) === 0 ? 'none' : formatRupees(Number(value))}`;
      return `${name} ${value}`;
    })
    .join(', ');
}

interface Props {
  api: Api;
  policyNumber: string;
  today: string;
}

export function PolicyFile({ api, policyNumber, today }: Props) {
  const [file, setFile] = useState<PolicyFileView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [date, setDate] = useState(today);
  const [asOf, setAsOf] = useState<PolicyAsOfView | null>(null);
  const showing = useAction();
  const downloading = useAction();

  useEffect(() => {
    let current = true;
    setFile(null);
    setAsOf(null);
    setLoadError(null);
    api
      .policyFile(policyNumber)
      .then(async (loaded) => {
        if (!current) return;
        setFile(loaded);
        const onDate = await api.policyAsOf(policyNumber, today);
        if (current) setAsOf(onDate);
      })
      .catch((error: unknown) => {
        if (current) setLoadError(error);
      });
    return () => {
      current = false;
    };
  }, [api, policyNumber, today]);

  const show = () => void showing.run(async () => setAsOf(await api.policyAsOf(policyNumber, date)));

  const open = (id: string) =>
    void downloading.run(async () => {
      const blob = await api.downloadDocument(id);
      window.open(URL.createObjectURL(blob), '_blank');
    });

  if (loadError !== null) return <ErrorList error={loadError} />;
  if (file === null) return <p>Loading...</p>;

  const status =
    file.cover.status === 'cancelled' && file.cover.cancelledOn !== null
      ? `Cancelled from ${formatDate(file.cover.cancelledOn)}`
      : file.cover.status === 'in_force'
        ? `In force (version ${file.cover.version})`
        : 'Not bound yet';

  return (
    <section className="policy-file">
      <h2>Policy {file.policyNumber}</h2>
      <p className="status">{status}</p>

      <h3>Versions</h3>
      <table aria-label="Versions">
        <thead>
          <tr>
            <th>Term</th>
            <th>Version</th>
            <th>Period</th>
            <th>Made by</th>
            <th>Job</th>
          </tr>
        </thead>
        <tbody>
          {file.versions.map((v) => (
            <tr key={`${v.termNumber}-${v.version}`}>
              <td>{v.termNumber}</td>
              <td>{v.version}</td>
              <td>
                {formatDate(v.periodStart)} to {formatDate(v.periodEnd)}
              </td>
              <td>{JOB_NAMES[v.jobType] ?? v.jobType}</td>
              <td>{v.jobNumber}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>The policy on a date</h3>
      <div className="as-of">
        <label>
          Show the policy as of
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>{' '}
        <button disabled={showing.busy} onClick={show}>
          Show
        </button>
      </div>
      <ErrorList error={showing.error} />
      {asOf && (
        <div>
          {asOf.status === 'in_force' ? <p>{asOf.message}</p> : <p className="warning">{`Not in force: ${asOf.message}`}</p>}
          {asOf.vehicles.map((vehicle, index) => (
            <p key={index}>
              {vehicle.make} {vehicle.model} {vehicle.year}, registration <strong>{vehicle.registrationNumber}</strong>
            </p>
          ))}
          {asOf.coverages.length > 0 && (
            <table aria-label="Covers on that date">
              <thead>
                <tr>
                  <th>Cover</th>
                  <th>Terms</th>
                </tr>
              </thead>
              <tbody>
                {asOf.coverages.map((coverage) => (
                  <tr key={coverage.patternCode}>
                    <td>{coverage.patternCode}</td>
                    <td>{describeTerms(coverage.terms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <h3>Premium transactions</h3>
      <table aria-label="Premium transactions">
        <thead>
          <tr>
            <th>Version</th>
            <th>Kind</th>
            <th>Effective</th>
            <th>Premium</th>
            <th>Tax</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {file.transactions.map((t) => (
            <tr key={`${t.version}-${t.kind}`}>
              <td>{t.version}</td>
              <td>{TRANSACTION_NAMES[t.kind] ?? t.kind}</td>
              <td>{formatDate(t.effectiveDate)}</td>
              <td>{formatRupees(t.premiumPaise)}</td>
              <td>{formatRupees(t.taxPaise)}</td>
              <td>{formatRupees(t.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Documents</h3>
      <ErrorList error={downloading.error} />
      <ul>
        {file.documents.map((document) => (
          <li key={document.id}>
            <button disabled={downloading.busy} onClick={() => open(document.id)}>
              {DOCUMENT_NAMES[document.kind] ?? document.kind} ({formatDate(document.createdAt.slice(0, 10))})
            </button>
          </li>
        ))}
        {file.documents.length === 0 && <li>No documents yet</li>}
      </ul>

      <h3>Claims</h3>
      <ul>
        {file.claims.map((claim) => (
          <li key={claim.claimNumber}>
            {`${claim.claimNumber}: ${claim.cause.replace(/_/g, ' ')} on ${formatDate(claim.lossDate)}, ${claim.status.replace(/_/g, ' ')} (${claim.verification.replace(/_/g, ' ')})`}
          </li>
        ))}
        {file.claims.length === 0 && <li>No claims</li>}
      </ul>
    </section>
  );
}
