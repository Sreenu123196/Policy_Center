import { useEffect, useState } from 'react';
import type { AccountView, Api } from './api.js';
import { ErrorList } from './ErrorList.js';
import { sentence } from './format.js';

// The accounts the signed-in user may see (the server already limits them by producer code), with a search box.
export function AccountList({ api }: { api: Api }) {
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let current = true;
    api
      .listAccounts()
      .then((page) => current && setAccounts(page.items))
      .catch((caught: unknown) => current && setError(caught));
    return () => {
      current = false;
    };
  }, [api]);

  if (error !== null) return <ErrorList error={error} />;
  if (accounts === null) return <p>Loading...</p>;

  const words = search.trim().toLowerCase();
  const shown = accounts.filter((a) => words === '' || a.accountNumber.toLowerCase().includes(words) || a.producerCode.toLowerCase().includes(words));

  return (
    <section>
      <h2>Accounts</h2>
      <label>
        Search by account number or producer code
        <input value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      {shown.length === 0 ? (
        <p className="muted">No account matches</p>
      ) : (
        <table aria-label="Accounts">
          <thead>
            <tr>
              <th>Account</th>
              <th>Producer code</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((account) => (
              <tr key={account.id}>
                <td>
                  <a href={`#/account/${account.id}`}>{account.accountNumber}</a>
                </td>
                <td>{account.producerCode}</td>
                <td>{sentence(account.status ?? 'active')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
