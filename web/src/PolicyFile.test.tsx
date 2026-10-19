// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { PolicyFile } from './PolicyFile.js';
import { asOf, fakeApi, policyFile } from './test-support.js';

afterEach(cleanup);

describe('the policy file', () => {
  it('shows the policy, its status, the timeline of versions, premium transactions, documents and claims', async () => {
    const api = fakeApi();
    render(<PolicyFile api={api} policyNumber="PL-0000001" today="2026-12-01" />);

    expect(await screen.findByRole('heading', { name: 'Policy PL-0000001' })).toBeTruthy();
    expect(api.policyFile).toHaveBeenCalledWith('PL-0000001');
    expect(screen.getByText('In force (version 2)')).toBeTruthy();

    const versions = screen.getByRole('table', { name: 'Versions' });
    const rows = within(versions).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('15-10-2026 to 15-10-2027')).toBeTruthy();
    expect(within(rows[1]!).getByText('Policy change')).toBeTruthy();

    const transactions = screen.getByRole('table', { name: 'Premium transactions' });
    expect(within(transactions).getByText('Rs 18,580.28')).toBeTruthy(); // version 1, the whole premium
    expect(within(transactions).getByText('Rs 4,453.60')).toBeTruthy(); // version 2, only the change
    expect(within(transactions).getByText('01-01-2027')).toBeTruthy();

    expect(screen.getByText(/CL-0000001/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /policy schedule/i })).toBeTruthy();
  });

  it('shows the policy as it was on any date: the vehicle, the covers and their terms', async () => {
    const api = fakeApi();
    render(<PolicyFile api={api} policyNumber="PL-0000001" today="2026-12-01" />);

    // First it shows today.
    await screen.findByText(/The policy was in force on 01-12-2026/);
    expect(api.policyAsOf).toHaveBeenCalledWith('PL-0000001', '2026-12-01');
    expect(screen.getByText(/Maruti Swift 2023/)).toBeTruthy();
    expect(screen.getByText('TS09XX0001')).toBeTruthy();
    const covers = screen.getByRole('table', { name: 'Covers on that date' });
    expect(within(covers).getByText('MOTOR_OD')).toBeTruthy();
    expect(within(covers).getByText('Insured value Rs 5,00,000.00')).toBeTruthy();

    // Then another date.
    api.policyAsOf.mockResolvedValueOnce({ ...asOf, date: '2027-02-01', version: 2, message: 'The policy was in force on 01-02-2027' });
    fireEvent.change(screen.getByLabelText('Show the policy as of'), { target: { value: '2027-02-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await screen.findByText(/in force on 01-02-2027/);
    expect(api.policyAsOf).toHaveBeenLastCalledWith('PL-0000001', '2027-02-01');
  });

  it('says clearly when the policy was not in force on the date', async () => {
    const api = fakeApi({ policyAsOf: async () => ({ ...asOf, status: 'not_in_force', message: 'The policy was cancelled from 01-01-2027', vehicles: [], coverages: [], version: 2 }) });
    render(<PolicyFile api={api} policyNumber="PL-0000001" today="2027-01-05" />);
    expect(await screen.findByText('Not in force: The policy was cancelled from 01-01-2027')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Covers on that date' })).toBeNull();
  });

  it('tells the person when the policy cannot be found (or may not be seen)', async () => {
    const api = fakeApi({ policyFile: async () => Promise.reject(new ApiError(404, 'not_found', 'The policy was not found')), policyAsOf: async () => Promise.reject(new ApiError(404, 'not_found', 'The policy was not found')) });
    render(<PolicyFile api={api} policyNumber="PL-9999999" today="2026-12-01" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByText('The policy was not found').length).toBeGreaterThan(0);
  });

  it('downloads a document with the signed-in user, since a plain link cannot carry the sign-in', async () => {
    const api = fakeApi();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    render(<PolicyFile api={api} policyNumber="PL-0000001" today="2026-12-01" />);
    fireEvent.click(await screen.findByRole('button', { name: /policy schedule/i }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:fake', '_blank'));
    expect(api.downloadDocument).toHaveBeenCalledWith(policyFile.documents[0]!.id);
    vi.unstubAllGlobals();
  });

  it('shows a cancelled policy as cancelled', async () => {
    const api = fakeApi({ policyFile: async () => ({ ...policyFile, cover: { status: 'cancelled', version: 3, cancelledOn: '2027-01-01' } }) });
    render(<PolicyFile api={api} policyNumber="PL-0000001" today="2026-12-01" />);
    expect(await screen.findByText('Cancelled from 01-01-2027')).toBeTruthy();
  });
});
