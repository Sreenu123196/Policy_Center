import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type DemoUser } from './App.js';
import { createApi } from './api.js';
import './styles.css';

// The demo users made by the API's seed (src/api/seed.ts). In production the identity provider supplies the user.
const users: DemoUser[] = [
  { username: 'asha.agent', label: 'Asha (agent, PC-100)' },
  { username: 'uma.underwriter', label: 'Uma (underwriter)' },
  { username: 'carl.claims', label: 'Carl (claims handler)' },
  { username: 'bina.billing', label: 'Bina (cashier)' },
  { username: 'root.admin', label: 'Root (administrator)' },
];

let currentUser: string | null = users[0]?.username ?? null;
const api = createApi({ getUser: () => currentUser });
const today = new Date().toISOString().slice(0, 10);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      api={api}
      users={users}
      today={today}
      onUserChange={(name) => {
        currentUser = name;
      }}
    />
  </StrictMode>,
);
