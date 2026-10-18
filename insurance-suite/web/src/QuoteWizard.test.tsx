// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { QuoteWizard } from './QuoteWizard.js';
import { fakeApi } from './test-support.js';

afterEach(cleanup);

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

function fillCustomer() {
  type('Full name', 'Asha Rao');
  type('Address line 1', '12 Test Street');
  type('City', 'Hyderabad');
  type('State', 'Telangana');
  type('PIN code', '500081');
  type('Producer code', 'PC-100');
}

function fillVehicle() {
  type('Policy start date', '2026-10-15');
  type('Make', 'Maruti');
  type('Model', 'Swift');
  type('Year of manufacture', '2023');
  type('Registration number', 'TS09XX0001');
  type('Engine size (cc)', '1197');
  type('Claim-free years', '2');
}

describe('the quote wizard', () => {
  it('takes an agent from a new customer to a bound and issued policy', async () => {
    const api = fakeApi();
    render(<QuoteWizard api={api} today="2026-10-16" />);

    // 1. The customer.
    expect(screen.getByRole('heading', { name: /1\. Customer/ })).toBeTruthy();
    fillCustomer();
    click('Continue');
    await screen.findByRole('heading', { name: /2\. Vehicle/ });
    expect(api.createContact).toHaveBeenCalledWith({ kind: 'person', name: 'Asha Rao', address: { line1: '12 Test Street', city: 'Hyderabad', state: 'Telangana', pinCode: '500081' } }, expect.any(String));
    expect(api.createAccount).toHaveBeenCalledWith({ namedInsuredContactId: 'contact-1', producerCode: 'PC-100' }, expect.any(String));

    // 2. The vehicle.
    fillVehicle();
    click('Continue');
    await screen.findByRole('heading', { name: /3\. Covers/ });
    expect(api.startSubmission).toHaveBeenCalledWith({ accountId: 'account-1', productCode: 'MOTOR_PRIVATE_CAR', periodStart: '2026-10-15' }, expect.any(String));
    expect(api.addVehicle).toHaveBeenCalledWith(
      'branch-1',
      { attributes: { make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001', engineCc: 1197, claimFreeYears: 2 } },
      expect.any(String),
    );

    // 3. The covers: the product decides what is offered; the required ones are on and cannot be switched off.
    const required = screen.getByLabelText('Third-party liability') as HTMLInputElement;
    expect(required.checked).toBe(true);
    expect(required.disabled).toBe(true);
    expect((screen.getByLabelText('Own damage') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Own damage'));
    type(/Insured value/, '5,00,000');
    expect(screen.getByText(/between Rs 50,000.00 and Rs 50,00,000.00/)).toBeTruthy();
    click('Get quote');

    // 4. The quote.
    await screen.findByRole('heading', { name: /4\. Quote/ });
    expect(api.addCoverage).toHaveBeenCalledTimes(3);
    expect(api.addCoverage).toHaveBeenCalledWith('branch-1', { coverableFixedId: 'vehicle-1', patternCode: 'MOTOR_OD', terms: { idv: 50000000, vol_deductible: 0 } }, expect.any(String));
    expect(api.addCoverage).toHaveBeenCalledWith('branch-1', { coverableFixedId: 'vehicle-1', patternCode: 'MOTOR_TP', terms: {} }, expect.any(String));
    expect(api.quote).toHaveBeenCalledWith('job-1', 'branch-1', expect.any(String));
    expect(screen.getByText('Rs 15,746.00')).toBeTruthy();
    expect(screen.getByText('Rs 2,834.28')).toBeTruthy();
    expect(screen.getByText('Rs 18,580.28')).toBeTruthy();
    expect(screen.getByText(/valid until 15-11-2026/i)).toBeTruthy();
    expect(screen.getByText('cost MOTOR_OD')).toBeTruthy();

    // 5. Bind and issue.
    click('Bind and issue');
    await screen.findByRole('heading', { name: /5\. Done/ });
    expect(api.bind).toHaveBeenCalledWith('job-1', 'branch-1', expect.any(String));
    expect(api.issue).toHaveBeenCalledWith('job-1', expect.any(String));
    const link = screen.getByRole('link', { name: 'PL-0000001' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/policy/PL-0000001');
  });

  it('shows every problem the server found and stays on the step, so the person can correct and try again with the same idempotency key', async () => {
    let calls = 0;
    const api = fakeApi({
      createContact: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(422, 'validation_failed', 'The request was refused', ['The PIN code must be 6 digits', 'The name is too short']);
        return { id: 'contact-1' };
      },
    });
    render(<QuoteWizard api={api} today="2026-10-16" />);
    fillCustomer();
    click('Continue');
    expect(await screen.findByText('The PIN code must be 6 digits')).toBeTruthy();
    expect(screen.getByText('The name is too short')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /1\. Customer/ })).toBeTruthy();

    type('PIN code', '500081');
    click('Continue');
    await screen.findByRole('heading', { name: /2\. Vehicle/ });
    expect(api.createContact.mock.calls[1]![1]).toBe(api.createContact.mock.calls[0]![1]); // the same key: a retry, not a second customer
    expect(screen.queryByText('The PIN code must be 6 digits')).toBeNull();
  });

  it('uses an existing customer without creating a contact', async () => {
    const api = fakeApi({ listAccounts: async () => ({ items: [{ id: 'account-9', accountNumber: 'AC-0000009', producerCode: 'PC-100' }], total: 1, limit: 200, offset: 0 }) });
    render(<QuoteWizard api={api} today="2026-10-16" />);
    fireEvent.click(await screen.findByLabelText('Existing customer'));
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'account-9' } });
    click('Continue');
    await screen.findByRole('heading', { name: /2\. Vehicle/ });
    expect(api.createContact).not.toHaveBeenCalled();
    fillVehicle();
    click('Continue');
    await screen.findByRole('heading', { name: /3\. Covers/ });
    expect(api.startSubmission).toHaveBeenCalledWith({ accountId: 'account-9', productCode: 'MOTOR_PRIVATE_CAR', periodStart: '2026-10-15' }, expect.any(String));
  });

  it('keeps the person on the covers step when the quote is refused, with the reasons', async () => {
    const api = fakeApi({ quote: async () => Promise.reject(new ApiError(422, 'validation_failed', 'The request was refused', ['MOTOR_OD: idv must be between 5000000 and 500000000'])) });
    render(<QuoteWizard api={api} today="2026-10-16" />);
    fillCustomer();
    click('Continue');
    await screen.findByRole('heading', { name: /2\. Vehicle/ });
    fillVehicle();
    click('Continue');
    await screen.findByRole('heading', { name: /3\. Covers/ });
    fireEvent.click(screen.getByLabelText('Own damage'));
    type(/Insured value/, '100');
    click('Get quote');
    expect(await screen.findByText(/idv must be between/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /3\. Covers/ })).toBeTruthy();
  });

  it('explains when the person may quote but not bind, and leaves the quote on screen', async () => {
    const api = fakeApi({ bind: async () => Promise.reject(new ApiError(403, 'forbidden', 'You do not have the permission policy.bind')) });
    render(<QuoteWizard api={api} today="2026-10-16" />);
    fillCustomer();
    click('Continue');
    await screen.findByRole('heading', { name: /2\. Vehicle/ });
    fillVehicle();
    click('Continue');
    await screen.findByRole('heading', { name: /3\. Covers/ });
    click('Get quote');
    await screen.findByRole('heading', { name: /4\. Quote/ });
    click('Bind and issue');
    expect(await screen.findByText(/not allowed.*policy\.bind/i)).toBeTruthy();
    expect(screen.getByText('Rs 18,580.28')).toBeTruthy();
    expect(api.issue).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Bind and issue' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('starts again from the first step', async () => {
    render(<QuoteWizard api={fakeApi()} today="2026-10-16" />);
    fillCustomer();
    click('Continue');
    await screen.findByRole('heading', { name: /2\. Vehicle/ });
    fillVehicle();
    click('Continue');
    await screen.findByRole('heading', { name: /3\. Covers/ });
    click('Get quote');
    await screen.findByRole('heading', { name: /4\. Quote/ });
    click('Start again');
    expect(await screen.findByRole('heading', { name: /1\. Customer/ })).toBeTruthy();
  });
});
