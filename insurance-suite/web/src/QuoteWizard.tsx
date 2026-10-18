import { useEffect, useRef, useState } from 'react';
import type { AccountView, Api, CoverageDef, ProductView, QuoteView, SubmissionView } from './api.js';
import { ErrorList } from './ErrorList.js';
import { formatDate, formatRupees, rupeesToPaise } from './format.js';
import { useAction } from './useAction.js';

// The quote wizard (document section 20): customer, vehicle, covers, quote, then bind and issue. Each step calls the API
// once it is complete, so the person can come back later with what is already saved, and the server checks every rule:
// the screen offers choices from the product and shows the server's reasons when something is refused.

const PRODUCT = 'MOTOR_PRIVATE_CAR';

type Step = 'customer' | 'vehicle' | 'covers' | 'quote' | 'done';

interface Props {
  api: Api;
  today: string; // yyyy-mm-dd
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label>
      {label}
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function QuoteWizard({ api, today }: Props) {
  const action = useAction();
  const [step, setStep] = useState<Step>('customer');

  // 1. customer
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [chosenAccount, setChosenAccount] = useState('');
  const [customer, setCustomer] = useState({ name: '', line1: '', city: '', state: '', pinCode: '', producerCode: 'PC-100' });
  const [accountId, setAccountId] = useState('');

  // 2. vehicle
  const [vehicle, setVehicle] = useState({ start: today, make: '', model: '', year: '', registration: '', engineCc: '', claimFree: '0' });
  const [submission, setSubmission] = useState<SubmissionView | null>(null);
  const [vehicleId, setVehicleId] = useState('');

  // 3. covers
  const [product, setProduct] = useState<ProductView | null>(null);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [idvText, setIdvText] = useState('500000');
  const [deductible, setDeductible] = useState('0');

  // 4. quote
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [policyNumber, setPolicyNumber] = useState('');
  const saved = useRef<Set<string>>(new Set()); // covers already added to the working copy

  useEffect(() => {
    api.listAccounts().then((page) => setAccounts(page.items), () => setAccounts([]));
  }, [api]);

  const update = <T extends object>(set: (value: T) => void, current: T, change: Partial<T>): void => set({ ...current, ...change });

  async function continueFromCustomer(): Promise<void> {
    if (mode === 'existing') {
      if (chosenAccount === '') throw new Error('Choose a customer');
      setAccountId(chosenAccount);
      return;
    }
    const contact = await api.createContact(
      { kind: 'person', name: customer.name, address: { line1: customer.line1, city: customer.city, state: customer.state, pinCode: customer.pinCode } },
      action.keyFor('contact'),
    );
    const account = await api.createAccount({ namedInsuredContactId: contact.id, producerCode: customer.producerCode }, action.keyFor('account'));
    action.forget('contact', 'account');
    setAccountId(account.id);
  }

  async function continueFromVehicle(): Promise<void> {
    const started = submission ?? (await api.startSubmission({ accountId, productCode: PRODUCT, periodStart: vehicle.start }, action.keyFor('submission')));
    setSubmission(started);
    const added = await api.addVehicle(
      started.branch.id,
      { attributes: { make: vehicle.make, model: vehicle.model, year: Number(vehicle.year), registrationNumber: vehicle.registration, engineCc: Number(vehicle.engineCc), claimFreeYears: Number(vehicle.claimFree) } },
      action.keyFor('vehicle'),
    );
    action.forget('submission', 'vehicle');
    setVehicleId(added.fixedId);
    const offered = await api.product(PRODUCT, vehicle.start);
    setProduct(offered);
    setChosen(Object.fromEntries(offered.coverages.map((c) => [c.code, c.existence === 'required'])));
  }

  function termsFor(coverage: CoverageDef): Record<string, number | string> {
    if (coverage.code !== 'MOTOR_OD') return {};
    const idv = rupeesToPaise(idvText);
    return { idv: idv ?? 0, vol_deductible: Number(deductible) };
  }

  async function getQuote(): Promise<void> {
    if (submission === null || product === null) return;
    for (const coverage of product.coverages.filter((c) => chosen[c.code])) {
      if (saved.current.has(coverage.code)) continue;
      await api.addCoverage(submission.branch.id, { coverableFixedId: vehicleId, patternCode: coverage.code, terms: termsFor(coverage) }, action.keyFor(`cover:${coverage.code}`));
      action.forget(`cover:${coverage.code}`);
      saved.current.add(coverage.code);
    }
    setQuote(await api.quote(submission.job.id, submission.branch.id, action.keyFor('quote')));
    action.forget('quote');
  }

  async function bindAndIssue(): Promise<void> {
    if (submission === null) return;
    await api.bind(submission.job.id, submission.branch.id, action.keyFor('bind'));
    action.forget('bind');
    await api.issue(submission.job.id, action.keyFor('issue'));
    action.forget('issue');
    setPolicyNumber(submission.policy.policyNumber);
  }

  const go = (work: () => Promise<void>, next: Step) => () => {
    void action.run(work).then((ok) => {
      if (ok) setStep(next);
    });
  };

  function reset(): void {
    setStep('customer');
    setSubmission(null);
    setQuote(null);
    setProduct(null);
    saved.current = new Set();
    action.clearError();
  }

  return (
    <section className="wizard">
      {step === 'customer' && (
        <div>
          <h2>1. Customer</h2>
          <div className="choice">
            <label>
              <input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} />
              New customer
            </label>
            <label>
              <input type="radio" name="mode" checked={mode === 'existing'} onChange={() => setMode('existing')} />
              Existing customer
            </label>
          </div>
          {mode === 'new' ? (
            <div className="form">
              <Field label="Full name" value={customer.name} onChange={(name) => update(setCustomer, customer, { name })} />
              <Field label="Address line 1" value={customer.line1} onChange={(line1) => update(setCustomer, customer, { line1 })} />
              <Field label="City" value={customer.city} onChange={(city) => update(setCustomer, customer, { city })} />
              <Field label="State" value={customer.state} onChange={(state) => update(setCustomer, customer, { state })} />
              <Field label="PIN code" value={customer.pinCode} onChange={(pinCode) => update(setCustomer, customer, { pinCode })} />
              <Field label="Producer code" value={customer.producerCode} onChange={(producerCode) => update(setCustomer, customer, { producerCode })} />
            </div>
          ) : (
            <label>
              Customer
              <select value={chosenAccount} onChange={(event) => setChosenAccount(event.target.value)}>
                <option value="">Choose...</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.accountNumber} ({account.producerCode})
                  </option>
                ))}
              </select>
            </label>
          )}
          <ErrorList error={action.error} />
          <button disabled={action.busy} onClick={go(continueFromCustomer, 'vehicle')}>
            Continue
          </button>
        </div>
      )}

      {step === 'vehicle' && (
        <div>
          <h2>2. Vehicle</h2>
          <div className="form">
            <Field label="Policy start date" type="date" value={vehicle.start} onChange={(start) => update(setVehicle, vehicle, { start })} />
            <Field label="Make" value={vehicle.make} onChange={(make) => update(setVehicle, vehicle, { make })} />
            <Field label="Model" value={vehicle.model} onChange={(model) => update(setVehicle, vehicle, { model })} />
            <Field label="Year of manufacture" value={vehicle.year} onChange={(year) => update(setVehicle, vehicle, { year })} />
            <Field label="Registration number" value={vehicle.registration} onChange={(registration) => update(setVehicle, vehicle, { registration })} />
            <Field label="Engine size (cc)" value={vehicle.engineCc} onChange={(engineCc) => update(setVehicle, vehicle, { engineCc })} />
            <Field label="Claim-free years" value={vehicle.claimFree} onChange={(claimFree) => update(setVehicle, vehicle, { claimFree })} />
          </div>
          <ErrorList error={action.error} />
          <button disabled={action.busy} onClick={go(continueFromVehicle, 'covers')}>
            Continue
          </button>
        </div>
      )}

      {step === 'covers' && product && (
        <div>
          <h2>3. Covers</h2>
          <p className="muted">
            {product.names.en}, version {product.version}
          </p>
          {product.coverages.map((coverage) => {
            const od = coverage.terms?.find((t) => t.code === 'idv');
            const deductibleTerm = coverage.terms?.find((t) => t.code === 'vol_deductible');
            return (
              <div key={coverage.code} className="cover">
                <label>
                  <input
                    type="checkbox"
                    checked={chosen[coverage.code] ?? false}
                    disabled={coverage.existence === 'required'}
                    onChange={(event) => setChosen({ ...chosen, [coverage.code]: event.target.checked })}
                  />
                  {coverage.names.en}
                </label>
                {coverage.code === 'MOTOR_OD' && chosen.MOTOR_OD && od?.type === 'direct' && (
                  <div className="terms">
                    <label>
                      Insured value (Rs)
                      <input value={idvText} onChange={(event) => setIdvText(event.target.value)} />
                    </label>
                    <small>
                      {' '}
                      between {formatRupees(od.min)} and {od.max === undefined ? 'no limit' : formatRupees(od.max)}
                    </small>
                    {deductibleTerm?.type === 'option' && (
                      <label>
                        Voluntary deductible
                        <select value={deductible} onChange={(event) => setDeductible(event.target.value)}>
                          {deductibleTerm.options.map((option) => (
                            <option key={option} value={String(option)}>
                              {Number(option) === 0 ? 'None' : formatRupees(Number(option))}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <ErrorList error={action.error} />
          <button disabled={action.busy} onClick={go(getQuote, 'quote')}>
            Get quote
          </button>
        </div>
      )}

      {step === 'quote' && quote && (
        <div>
          <h2>4. Quote</h2>
          <table className="amounts">
            <tbody>
              <tr>
                <th>Premium</th>
                <td>{formatRupees(quote.premiumPaise)}</td>
              </tr>
              <tr>
                <th>GST</th>
                <td>{formatRupees(quote.taxPaise)}</td>
              </tr>
              <tr className="total">
                <th>Total</th>
                <td>{formatRupees(quote.totalPaise)}</td>
              </tr>
            </tbody>
          </table>
          <p>
            This quote is valid until {formatDate(quote.validUntil)}. Rate book {quote.rateBook}.
          </p>
          <details>
            <summary>How the price was worked out</summary>
            <table>
              <tbody>
                {quote.worksheet.map((line, index) => (
                  <tr key={index}>
                    <td>{line.step}</td>
                    <td>{line.amountPaise === undefined ? line.note : formatRupees(line.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <ErrorList error={action.error} />
          <button disabled={action.busy} onClick={go(bindAndIssue, 'done')}>
            Bind and issue
          </button>{' '}
          <button disabled={action.busy} onClick={reset}>
            Start again
          </button>
        </div>
      )}

      {step === 'done' && (
        <div>
          <h2>5. Done</h2>
          <p>
            The policy is issued: <a href={`#/policy/${policyNumber}`}>{policyNumber}</a>
          </p>
          <button onClick={reset}>New quote</button>
        </div>
      )}
    </section>
  );
}
