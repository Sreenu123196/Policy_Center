// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fakeApi } from './test-support.js';

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = '';
});

const users = [
  { username: 'asha.agent', label: 'Asha (agent)' },
  { username: 'uma.underwriter', label: 'Uma (underwriter)' },
];

describe('the application', () => {
  it('opens on the quote wizard, and shows who is signed in', () => {
    render(<App api={fakeApi()} users={users} today="2026-10-16" onUserChange={() => undefined} />);
    expect(screen.getByRole('heading', { name: /1\. Customer/ })).toBeTruthy();
    expect((screen.getByLabelText('Signed in as') as HTMLSelectElement).value).toBe('asha.agent');
  });

  it('tells the API client who is calling, first the user shown at the start and then each user chosen', () => {
    const chosen: string[] = [];
    render(<App api={fakeApi()} users={users} today="2026-10-16" onUserChange={(name) => chosen.push(name)} />);
    fireEvent.change(screen.getByLabelText('Signed in as'), { target: { value: 'uma.underwriter' } });
    expect(chosen).toEqual(['asha.agent', 'uma.underwriter']);
  });

  it('opens a policy file from the address, and from the search box', async () => {
    window.location.hash = '#/policy/PL-0000001';
    const api = fakeApi();
    render(<App api={api} users={users} today="2026-10-16" onUserChange={() => undefined} />);
    expect(await screen.findByRole('heading', { name: 'Policy PL-0000001' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Go to policy'), { target: { value: 'pl-0000002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(window.location.hash).toBe('#/policy/PL-0000002');
    await screen.findByRole('heading', { name: 'Policy PL-0000002' });
    expect(api.policyFile).toHaveBeenLastCalledWith('PL-0000002');
  });

  it('goes back to the wizard from the menu', async () => {
    window.location.hash = '#/policy/PL-0000001';
    render(<App api={fakeApi()} users={users} today="2026-10-16" onUserChange={() => undefined} />);
    await screen.findByRole('heading', { name: 'Policy PL-0000001' });
    fireEvent.click(screen.getByRole('link', { name: 'New quote' }));
    expect(await screen.findByRole('heading', { name: /1\. Customer/ })).toBeTruthy();
  });
});
