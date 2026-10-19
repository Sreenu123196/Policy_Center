// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountList } from './AccountList.js';
import { AccountPage } from './AccountPage.js';
import { ApiError } from './api.js';
import { billing, fakeApi } from './test-support.js';

afterEach(cleanup);

describe('the account list', () => {
  it('lists the accounts the user may see, with a link to each, and narrows them as the person types', async () => {
    const api = fakeApi();
    render(<AccountList api={api} />);
    const table = await screen.findByRole('table', { name: 'Accounts' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'AC-0000001' }).getAttribute('href')).toBe('#/account/acc-1');
    expect(within(rows[1]!).getByText('Closed')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search by account number or producer code'), { target: { value: 'pc-200' } });
    expect(within(screen.getByRole('table', { name: 'Accounts' })).getAllByRole('row').slice(1)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'AC-0000002' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search by account number or producer code'), { target: { value: 'nothing' } });
    expect(screen.getByText('No account matches')).toBeTruthy();
  });

  it('shows the reason when the list cannot be loaded', async () => {
    render(<AccountList api={fakeApi({ listAccounts: async () => Promise.reject(new ApiError(0, 'network', 'The server could not be reached')) })} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('The server could not be reached')).toBeTruthy();
  });
});

describe('the account page', () => {
  it('shows the account and its billing: what is owed, the invoices, the instalment schedule and the credits', async () => {
    const api = fakeApi();
    render(<AccountPage api={api} accountId="acc-1" />);
    expect(await screen.findByRole('heading', { name: 'Account AC-0000001' })).toBeTruthy();
    expect(api.account).toHaveBeenCalledWith('acc-1');
    expect(api.billing).toHaveBeenCalledWith('acc-1');
    expect(await screen.findByText('Producer code PC-100')).toBeTruthy();

    // What the customer owes is the sum of the open invoices, taken from the server's own figures.
    expect(screen.getByText('Outstanding: Rs 8,580.28')).toBeTruthy();
    expect(screen.getByText('Credit to use or refund: Rs 400.00')).toBeTruthy();

    const invoices = screen.getByRole('table', { name: 'Invoices' });
    const rows = within(invoices).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('INV-0000001')).toBeTruthy();
    expect(within(rows[0]!).getByText('15-10-2026')).toBeTruthy();
    expect(within(rows[0]!).getByText('Rs 8,580.28')).toBeTruthy();
    expect(within(rows[1]!).getByText('Paid')).toBeTruthy();

    const schedule = screen.getByRole('table', { name: 'Payment schedule' });
    expect(within(schedule).getByText('01-01-2027')).toBeTruthy();
    expect(within(schedule).getByText('Scheduled')).toBeTruthy();
    expect(within(schedule).getAllByRole('link', { name: 'PL-0000001' })[0]!.getAttribute('href')).toBe('#/policy/PL-0000001');
  });

  it('says so when nothing is owed', async () => {
    const paid = { ...billing, invoices: billing.invoices.map((i) => ({ ...i, paidPaise: i.totalPaise, outstandingPaise: 0, status: 'paid' as const })), credits: [] };
    render(<AccountPage api={fakeApi({ billing: async () => paid })} accountId="acc-1" />);
    expect(await screen.findByText('Outstanding: Rs 0.00')).toBeTruthy();
    expect(screen.queryByText(/Credit to use/)).toBeNull();
  });

  it('still shows the account when the person may not see billing (missing permission), and explains why', async () => {
    const api = fakeApi({ billing: async () => Promise.reject(new ApiError(403, 'forbidden', 'billing.view')) });
    render(<AccountPage api={api} accountId="acc-1" />);
    expect(await screen.findByRole('heading', { name: 'Account AC-0000001' })).toBeTruthy();
    expect(await screen.findByText(/You are not allowed to do this/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Invoices' })).toBeNull();
  });

  it('says when the account has no billing yet (nothing has been bound)', async () => {
    const api = fakeApi({ billing: async () => Promise.reject(new ApiError(404, 'not_found', 'The billing account was not found')) });
    render(<AccountPage api={api} accountId="acc-1" />);
    expect(await screen.findByText('Nothing has been billed on this account yet')).toBeTruthy();
  });

  it('tells the person when the account cannot be found, or may not be seen', async () => {
    const api = fakeApi({ account: async () => Promise.reject(new ApiError(404, 'not_found', 'The account was not found')) });
    render(<AccountPage api={api} accountId="nope" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('The account was not found')).toBeTruthy();
  });
});
