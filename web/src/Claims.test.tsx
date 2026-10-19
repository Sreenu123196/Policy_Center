// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { ClaimList } from './ClaimList.js';
import { ClaimPage } from './ClaimPage.js';
import { fakeApi } from './test-support.js';

afterEach(cleanup);

describe('the claim list', () => {
  it('lists claims with their policy, loss date, cause and status, linked to the claim and the policy', async () => {
    render(<ClaimList api={fakeApi()} />);
    const table = await screen.findByRole('table', { name: 'Claims' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'CL-0000001' }).getAttribute('href')).toBe('#/claim/CL-0000001');
    expect(within(rows[0]!).getByRole('link', { name: 'PL-0000001' }).getAttribute('href')).toBe('#/policy/PL-0000001');
    expect(within(rows[0]!).getByText('01-12-2026')).toBeTruthy();
    expect(within(rows[0]!).getByText('collision')).toBeTruthy();
    expect(within(rows[0]!).getByText('Under review')).toBeTruthy();
    // A late report or an unverified policy is flagged so a handler looks at it first.
    expect(within(rows[1]!).getByText('Reported late')).toBeTruthy();
    expect(within(rows[1]!).getByText('Not verified')).toBeTruthy();
  });

  it('filters by status and by words', async () => {
    render(<ClaimList api={fakeApi()} />);
    await screen.findByRole('table', { name: 'Claims' });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'rejected' } });
    expect(within(screen.getByRole('table', { name: 'Claims' })).getAllByRole('row').slice(1)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'CL-0000002' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Search by claim or policy number'), { target: { value: 'pl-0000001' } });
    expect(within(screen.getByRole('table', { name: 'Claims' })).getAllByRole('row').slice(1)).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search by claim or policy number'), { target: { value: 'zzz' } });
    expect(screen.getByText('No claim matches')).toBeTruthy();
  });

  it('shows the reason when the list cannot be loaded', async () => {
    render(<ClaimList api={fakeApi({ listClaims: async () => Promise.reject(new ApiError(403, 'forbidden', 'no')) })} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('the claim page', () => {
  it('shows what happened, then each exposure with its limit and its money, and the totals', async () => {
    const api = fakeApi();
    render(<ClaimPage api={api} claimNumber="CL-0000001" />);
    expect(await screen.findByRole('heading', { name: 'Claim CL-0000001' })).toBeTruthy();
    expect(api.claim).toHaveBeenCalledWith('CL-0000001');
    expect(api.claimFinancials).toHaveBeenCalledWith('CL-0000001');
    expect(screen.getByText('Rear-ended at a signal')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'PL-0000001' }).getAttribute('href')).toBe('#/policy/PL-0000001');
    expect(screen.getByText(/Loss on 01-12-2026 at Hyderabad, reported 02-12-2026/)).toBeTruthy();

    const exposures = await screen.findByRole('table', { name: 'Exposures' });
    const rows = within(exposures).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('MOTOR_OD')).toBeTruthy();
    expect(within(rows[0]!).getByText('Asha Rao (insured)')).toBeTruthy();
    expect(within(rows[0]!).getByText('Rs 5,00,000.00')).toBeTruthy(); // the limit: the insured value on the loss date
    expect(within(rows[0]!).getByText('Rs 30,000.00')).toBeTruthy(); // paid
    expect(within(rows[0]!).getByText('Rs 35,000.00')).toBeTruthy(); // incurred = paid + outstanding - recovered
    expect(within(rows[1]!).getByText('Ravi Kumar (third_party)')).toBeTruthy();
    expect(within(rows[1]!).getByText('No limit')).toBeTruthy();

    const totals = screen.getByRole('table', { name: 'Claim totals' });
    expect(within(totals).getByText('Rs 45,000.00')).toBeTruthy(); // incurred of the whole claim
    expect(within(totals).getByText('Claim cost')).toBeTruthy();
    expect(within(totals).getByText('Expense')).toBeTruthy();
  });

  it('shows the money columns as unavailable, not as zero, when the financials cannot be loaded', async () => {
    const api = fakeApi({ claimFinancials: async () => Promise.reject(new ApiError(500, 'internal_error', 'Something went wrong')) });
    render(<ClaimPage api={api} claimNumber="CL-0000001" />);
    expect(await screen.findByRole('table', { name: 'Exposures' })).toBeTruthy();
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Claim totals' })).toBeNull();
  });

  it('warns that a claim reported late, or on a policy that could not be verified, needs a decision', async () => {
    render(<ClaimPage api={fakeApi()} claimNumber="CL-0000002" />);
    expect(await screen.findByRole('heading', { name: 'Claim CL-0000002' })).toBeTruthy();
    expect(screen.getByText('This claim was reported late.')).toBeTruthy();
    expect(screen.getByText('The policy could not be verified for the loss date; a handler must decide.')).toBeTruthy();
  });

  it('tells the person when the claim cannot be found, or may not be seen', async () => {
    const api = fakeApi({ claim: async () => Promise.reject(new ApiError(404, 'not_found', 'The claim was not found')) });
    render(<ClaimPage api={api} claimNumber="CL-9999999" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('The claim was not found')).toBeTruthy();
  });
});
