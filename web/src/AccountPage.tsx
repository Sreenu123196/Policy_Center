import { useEffect, useState } from 'react';
import { ApiError, type AccountView, type Api, type BillingView } from './api.js';
import { ErrorList } from './ErrorList.js';
import { formatDate, formatRupees, sentence } from './format.js';

// One account and its billing (document sections 14 and 20): what is owed, the invoices, the payment schedule and any
// credit. The figures come from the server; the screen only adds them up for display. A person who may see the
// account but not billing (no billing.view) still sees the account, with the reason.
export function AccountPage({ api, accountId }: { api: Api; accountId: string }) {
  const [account, setAccount] = useState<AccountView | null>(null);
  const [accountError, setAccountError] = useState<unknown>(null);
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [billingError, setBillingError] = useState<unknown>(null);

  useEffect(() => {
    let current = true;
    setAccount(null);
    setBilling(null);
    setAccountError(null);
    setBillingError(null);
    api
      .account(accountId)
      .then((loaded) => current && setAccount(loaded))
      .catch((caught: unknown) => current && setAccountError(caught));
    api
      .billing(accountId)
      .then((loaded) => current && setBilling(loaded))
      .catch((caught: unknown) => current && setBillingError(caught));
    return () => {
      current = false;
    };
  }, [api, accountId]);

  if (accountError !== null) return <ErrorList error={accountError} />;
  if (account === null) return <p>Loading...</p>;

  const nothingBilled = billingError instanceof ApiError && billingError.status === 404;
  const outstanding = billing?.invoices.filter((i) => i.status === 'open').reduce((sum, i) => sum + i.outstandingPaise, 0) ?? 0;
  const credit = billing?.credits.filter((c) => c.status === 'open').reduce((sum, c) => sum + c.remainingPaise, 0) ?? 0;

  return (
    <section className="account-page">
      <h2>Account {account.accountNumber}</h2>
      <p>{`Producer code ${account.producerCode}`}</p>
      <p className="status">{sentence(account.status ?? 'active')}</p>

      <h3>Billing</h3>
      {nothingBilled && <p className="muted">Nothing has been billed on this account yet</p>}
      {!nothingBilled && <ErrorList error={billingError} />}
      {billing === null && billingError === null && <p>Loading...</p>}
      {billing && (
        <div>
          <p>{`Payment plan ${billing.account.planCode}`}</p>
          <p className="status">{`Outstanding: ${formatRupees(outstanding)}`}</p>
          {credit > 0 && <p>{`Credit to use or refund: ${formatRupees(credit)}`}</p>}

          <h3>Invoices</h3>
          <table aria-label="Invoices">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>Due</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Outstanding</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {billing.invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>{invoice.number}</td>
                  <td>{formatDate(invoice.invoiceDate)}</td>
                  <td>{formatDate(invoice.dueDate)}</td>
                  <td>{formatRupees(invoice.totalPaise)}</td>
                  <td>{formatRupees(invoice.paidPaise)}</td>
                  <td>{formatRupees(invoice.outstandingPaise)}</td>
                  <td>{sentence(invoice.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Payment schedule</h3>
          <table aria-label="Payment schedule">
            <thead>
              <tr>
                <th>Policy</th>
                <th>For</th>
                <th>Due</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {billing.scheduleItems.map((item) => (
                <tr key={item.id}>
                  <td>
                    <a href={`#/policy/${item.policyNumber}`}>{item.policyNumber}</a>
                  </td>
                  <td>{`${sentence(item.kind)} ${item.sequence}`}</td>
                  <td>{formatDate(item.dueDate)}</td>
                  <td>{formatRupees(item.amountPaise)}</td>
                  <td>{sentence(item.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
