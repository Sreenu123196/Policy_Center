import { join } from 'node:path';
import { loadBillingConfig, type BillingConfigCatalogue } from '../billing/index.js';
import { loadClaimsConfig, type ClaimsConfigCatalogue } from '../claims/index.js';
import {
  createQuoter,
  loadCancellationRules,
  loadProductCatalogue,
  loadRateBooks,
  loadRenewalRules,
  loadUnderwritingRules,
  type CancellationRulesCatalogue,
  type ProductCatalogue,
  type Quoter,
  type RenewalRulesCatalogue,
  type UwRulesCatalogue,
} from '../policy/index.js';

// Everything the API needs from the configuration folder, loaded once at start-up (document section 18). A mistake in
// any file stops the start-up with the list of problems, so a bad configuration never reaches a customer.
export interface ApiConfig {
  catalogue: ProductCatalogue;
  quoter: Quoter;
  underwriting: UwRulesCatalogue;
  cancellation: CancellationRulesCatalogue;
  renewal: RenewalRulesCatalogue;
  billing: BillingConfigCatalogue;
  claims: ClaimsConfigCatalogue;
}

export function loadApiConfig(configFolder: string): ApiConfig {
  const catalogue = loadProductCatalogue(join(configFolder, 'products'));
  return {
    catalogue,
    quoter: createQuoter(loadRateBooks(join(configFolder, 'ratebooks'), catalogue)),
    underwriting: loadUnderwritingRules(join(configFolder, 'underwriting'), catalogue),
    cancellation: loadCancellationRules(join(configFolder, 'cancellation'), catalogue),
    renewal: loadRenewalRules(join(configFolder, 'renewal'), catalogue),
    billing: loadBillingConfig(join(configFolder, 'billing')),
    claims: loadClaimsConfig(join(configFolder, 'claims')),
  };
}
