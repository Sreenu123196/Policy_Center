import { useEffect, useState } from 'react';
import { AccountList } from './AccountList.js';
import { AccountPage } from './AccountPage.js';
import type { Api } from './api.js';
import { ClaimList } from './ClaimList.js';
import { ClaimPage } from './ClaimPage.js';
import { PolicyFile } from './PolicyFile.js';
import { QuoteWizard } from './QuoteWizard.js';

// The frame of the screens: who is signed in, the menu, and which screen the address (#/...) asks for.
// In production an identity provider signs people in; here a demo user can be chosen to try the different roles.

export interface DemoUser {
  username: string;
  label: string;
}

interface Props {
  api: Api;
  users: DemoUser[];
  today: string;
  onUserChange: (username: string) => void;
}

// The address after the # says which screen to show.
type Screen = { name: 'wizard' } | { name: 'policy'; id: string } | { name: 'accounts' } | { name: 'account'; id: string } | { name: 'claims' } | { name: 'claim'; id: string };

function screenFromHash(hash: string): Screen {
  const match = /^#\/(policy|account|claim)\/([A-Za-z0-9-]+)$/.exec(hash);
  if (match) return { name: match[1] as 'policy' | 'account' | 'claim', id: match[2]! };
  if (hash === '#/accounts') return { name: 'accounts' };
  if (hash === '#/claims') return { name: 'claims' };
  return { name: 'wizard' };
}

export function App({ api, users, today, onUserChange }: Props) {
  const [user, setUser] = useState(users[0]?.username ?? '');
  const [hash, setHash] = useState(window.location.hash);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const listener = () => setHash(window.location.hash);
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    onUserChange(user);
  }, [user, onUserChange]);

  const screen = screenFromHash(hash);

  return (
    <div className="app">
      <header>
        <h1>Insurance Suite</h1>
        <nav>
          <a href="#/">New quote</a>
          <a href="#/accounts">Accounts</a>
          <a href="#/claims">Claims</a>
          <label>
            Go to policy
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="PL-0000001" />
          </label>
          <button
            onClick={() => {
              if (search.trim() !== '') window.location.hash = `#/policy/${search.trim().toUpperCase()}`;
            }}
          >
            Open
          </button>
        </nav>
        <label className="user">
          Signed in as
          <select value={user} onChange={(event) => setUser(event.target.value)}>
            {users.map((u) => (
              <option key={u.username} value={u.username}>
                {u.username}
              </option>
            ))}
          </select>
        </label>
      </header>
      {/* A screen is loaded again for another user (they may see different things); the wizard keeps its work, so a quote made by an agent can be bound by an underwriter. */}
      <main key={screen.name === 'wizard' ? 'wizard' : `${user}:${screen.name}:${'id' in screen ? screen.id : ''}`}>
        {screen.name === 'wizard' && <QuoteWizard api={api} today={today} />}
        {screen.name === 'policy' && <PolicyFile api={api} policyNumber={screen.id} today={today} />}
        {screen.name === 'accounts' && <AccountList api={api} />}
        {screen.name === 'account' && <AccountPage api={api} accountId={screen.id} />}
        {screen.name === 'claims' && <ClaimList api={api} />}
        {screen.name === 'claim' && <ClaimPage api={api} claimNumber={screen.id} />}
      </main>
    </div>
  );
}
