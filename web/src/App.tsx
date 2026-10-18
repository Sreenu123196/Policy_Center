import { useEffect, useState } from 'react';
import type { Api } from './api.js';
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

const policyFromHash = (hash: string): string | null => /^#\/policy\/([A-Za-z0-9-]+)$/.exec(hash)?.[1] ?? null;

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

  const policyNumber = policyFromHash(hash);

  return (
    <div className="app">
      <header>
        <h1>Insurance Suite</h1>
        <nav>
          <a href="#/">New quote</a>
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
      {/* A policy file is loaded again for another user (they may see different things); the wizard keeps its work, so a quote made by an agent can be bound by an underwriter. */}
      <main key={policyNumber ? `${user}:${policyNumber}` : 'wizard'}>
        {policyNumber ? <PolicyFile api={api} policyNumber={policyNumber} today={today} /> : <QuoteWizard api={api} today={today} />}
      </main>
    </div>
  );
}
