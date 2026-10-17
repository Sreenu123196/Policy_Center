# PolicyCenter Simulator: Personal Auto & Homeowners

A runnable, PolicyCenter-style policy administration app. It models the parts of Guidewire PolicyCenter
that matter when you design or explain a PolicyCenter implementation: product model, rating with worksheets,
the job framework, underwriting referrals with authority levels, and what binding produces downstream.

It is a simulator, not Guidewire code. There is no Gosu, PCF or Guidewire base. Each concept maps to a
plain JavaScript module so you can read it end to end.

## Run it

Requires Node.js 20+. There are no npm dependencies.

```bash
cd PolicyCenter-Sim
npm start          # http://localhost:3000
npm test           # 15 tests: rating + full policy lifecycle
```

Data is saved to `data/policycenter.json`. Delete that file (or use **Administration → Reset demo data**
as the UW Manager) to reload the demo data. Use the user picker in the top bar to switch between
users and roles.

| User | Role | UW authority | Sees |
|---|---|---|---|
| Alex Agent | Agent | 0 | Accounts for producer code PC-100 only |
| Blair Broker | Agent | 0 | Accounts for producer code PC-200 only |
| Uma Underwriter | Underwriter | 1 | Everything; approves level-1 issues |
| Morgan Lee | UW Manager | 2 | Everything; approves all issues, runs batch, resets data |

## What's modelled

| PolicyCenter concept | Where | Notes |
|---|---|---|
| Product model (APD / Product Designer) | `src/productModel.js` | PA: line coverages + per-vehicle coverages, PIP only in FL/NY. HO: HO-3, HO-5, HO-4, HO-6 forms, Section I/II, deductibles, endorsements. Availability by state and form. |
| Rating Management | `src/rateBooks.js`, `src/rating.js` | Effective-dated rate books (2026.1, 2027.1, plus a Draft 2027.2 that is never used). Each cost has a factor-by-factor worksheet. |
| Validation rules | `src/validation.js` | Block the quote: VIN format, driver age, Collision requires Comprehensive, UM ≤ BI, Cov C ≤ Cov A, and others. |
| UW rules / UW issues | `src/uwRules.js` | BlocksQuote / BlocksBind, approval level, issues that can't be approved (declines). An approval stays valid on re-quote unless the risk gets worse. |
| Job framework | `src/policyCenter.js` | Submission, PolicyChange (pro-rated, out-of-sequence changes rejected), Renewal (120-day window, new rate book), Cancellation (flat / pro rata / short rate, notice periods), Reinstatement. |
| Effective-dated policy versions | `policy.versions` | Each bound job adds a version. Terms are grouped by term number. |
| Activities / referrals | `refer()` | Sent to the Underwriter or UW Manager queue by the authority the issue needs. |
| BillingCenter integration | invoices | Installment schedule per payment plan, plus adjustment invoices and credits. |
| Document production | documents | Declarations, ID cards, endorsements and notices, with a printable dec page. |
| App Events / messaging | event outbox | `PolicyIssued`, `PolicyChanged`, `PolicyRenewed`, `PolicyCancelled`, `PolicyReinstated`, `Account*`. |
| Batch processes | `runRenewalBatch` | Starts and quotes renewals within the window. |
| Cloud API | `src/api.js` | REST endpoints, with the caller identified by the `X-User` header. Each write runs as one unit of work and rolls back on error. |
| Producer-code security | `canSee()` | Agents only see their own producer code's accounts. |

## Demo data (relative to today)

- **Jordan Rivera (TX)**: HO-3 and Personal Auto with a teen good-student driver. Monthly plan, multi-policy discount, and a bound policy change that adds rental and towing.
- **Priya Shah (IL)**: HO-5 with scheduled jewelry and identity theft coverage.
- **Marcus Chen (FL)**: HO-3 quoted with wind/hail. Bind is blocked by a 22-year-old roof, and there's a referral for the Underwriter.
- **Emily Carter (OH)**: Personal Auto. The quote is blocked by 2 at-fault accidents, and there's a referral for the Underwriter.
- **Ava Thompson (CA)**: HO-4 renters policy, cancelled at the insured's request (short rate). Can be reinstated.
- **Daniel Kim (NY)**: Personal Auto with PIP. Expires within 60 days, so it's a candidate for the renewal batch.

## PolicyCenter Assistant (chatbot)

Click **Ask PolicyCenter** at the bottom right of any screen. The assistant looks up accounts, policies and jobs.
It explains premiums from the rating worksheet and underwriting issues, and summarizes the book of business. It
knows which record you have open, so "Why is this premium so high?" works on a policy or job page. Record numbers
in its answers are links.

- **Claude mode:** set an Anthropic API key before starting the server. The assistant then runs Claude Haiku 5.5 (`claude-haiku-5-5`)
  with tool use over nine read-only PolicyCenter tools (`src/chatbot.js`).

  ```bash
  ANTHROPIC_API_KEY=sk-ant-... npm start      # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."; npm start
  ```

  A user-scoped key (`sk-ant-usr-...`) also needs your workspace ID (`wrkspc_...`), either in `chat.config.json`
  (copy `chat.config.example.json`)
  as `{"workspaceId": "..."}` or in `ANTHROPIC_WORKSPACE_ID`.
  Set `CHAT_MODEL` to use a different model (for example `claude-opus-5-5`). Effort is set to `low` to keep
  chat fast. Server-side refusal fallback is turned on for models that support it; Haiku 5.5 has none. API usage is billed to that key.
- **Offline mode:** used when no key is set. It answers lookups by number, referrals, book summaries and name
  searches directly from the data, with no AI.
- **Security:** tools run as the signed-in user, so agents only see their own producer code's records. The
  assistant is read-only. It can't quote, bind, change or approve, and it tells you which screen to use instead.
- **Live answers:** replies stream in word by word, with a live line for each lookup ("Looking up policy
  PA-0000001…"). While it answers, the send arrow becomes a stop button.
- **Languages:** type or speak English, Hindi, Telugu, Hinglish or Tenglish; the assistant replies in the same
  language and script.
- **Voice:** with Google Cloud Speech set up (below), the mic records what you say and Google detects whether it
  is English, Hindi or Telugu, so there is nothing to choose. Click the mic again or press Send to finish; the text
  appears after you stop. Without Google, the mic uses the browser's own recognition (Chrome and Edge) as English
  (India), which handles English, Hinglish and Tenglish.

### Google Cloud Speech setup (automatic language detection)

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project with billing on, and
   enable the **Cloud Speech-to-Text API**.
2. Under **IAM & Admin → Service accounts**, create a service account with the **Cloud Speech Client** role.
3. Open it, choose **Keys → Add key → Create new key → JSON**, and save the file **outside this project folder**
   (for example `C:\Users\<you>\keys\policycenter-speech.json`). Never commit it.
4. Start the server with the key path set:

   ```powershell
   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\Users\<you>\keys\policycenter-speech.json"; $env:ANTHROPIC_API_KEY="<key>"; npm start
   ```

   The server prints `Voice input: Google Cloud Speech (chirp_3, auto-detects en-IN, hi-IN, te-IN)`.

It uses the Chirp 3 model in Google's `us` region (set `"speechRegion": "eu"` in `chat.config.json` for Europe);
audio is sent to Google for transcription. Telugu is a Preview language for Chirp 3. Each recording is transcribed
in its most prominent language, so heavily mixed speech may come back in one script. Optional settings in
`chat.config.json`: `speechRegion`, `speechLanguages`, `speechModel`.
- **API:** `POST /api/chat/stream` streams Server-Sent Events (`meta`, `tool`, `delta`, `reset`, `done`, `error`).
  `POST /api/chat` returns the whole answer at once, and `GET /api/chat/status` reports the mode. The request body
  is `{conversationId?, message, context}`. Conversations are kept in server memory and reset when the server
  restarts.

## Bulk test data

```bash
npm run generate -- 100 42   # count, random seed (same seed = same data)
```

Stop the server first, because it holds data in memory and would overwrite the new records. The script adds
accounts with bound policies across all six states and both producer codes. It mixes Personal Auto,
Homeowners (all four forms) and bundled accounts. Every record goes through validation, rating and UW rules,
and the UW Manager approves any issues. Some policies also get a later policy change or cancellation.
To start over, delete `data/policycenter.json` and run the script again; it reloads the demo data first.

## REST API

```
GET  /api/meta | /api/desktop | /api/search?q=
GET  /api/accounts?q=          POST /api/accounts         GET|PUT /api/accounts/:id
POST /api/jobs/submission      GET  /api/jobs/:id         PUT /api/jobs/:id/period
POST /api/jobs/:id/quote | bind | withdraw | decline
POST /api/jobs/:id/uw-issues/:key/approve
GET  /api/policies?q=          GET  /api/policies/:id
POST /api/policies/:id/change | cancel | reinstate | renew
GET  /api/activities           POST /api/activities/:id/complete
GET  /api/ratebooks | /api/events
POST /api/batch/renewals       POST /api/admin/reset
```

## Simplifications

- One rated driver per policy (the highest-rated driver), instead of assigning drivers to vehicles.
- Territories come from the ZIP prefix. A real implementation would read a ZIP-to-territory rate table.
- Out-of-sequence changes and concurrent jobs on a policy are rejected rather than merged or pre-empted.
- Billing is an invoice stream only. Payments, delinquency and cancellation for non-payment from billing are out of scope.
- No authentication: the user picker stands in for sign-in.
