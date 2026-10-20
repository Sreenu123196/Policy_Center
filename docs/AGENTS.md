# AI agents

Built from `PolicyCenter-Production-and-Agents-Plan.pdf`. The plan's rule: agents do the routine work, people approve the decisions that can hurt a customer. This is **plan phase 3 (suggest-only agents) plus the safety foundation it needs** (the audit log, accounts, limits, a kill switch, a test before trust). Nothing here changes a policy by itself.

## How it works

```
event or daily sweep -> agent reads the books -> SUGGESTION (with reasons)  -> person accepts / dismisses
                                                       |                              |
                                                  audit log  <-----------------------+
```

- **One account per agent** (`ai-renewal`, `ai-billing`, ...), role `AI Agent` in `src/permissions.js`. No password, so nobody can sign in as an agent. It may read what its job needs (accounts, policies, sales lists, billing, rating factors, underwriting notes) and never claim reserves. It has no write access: it writes suggestions and audit entries only.
- **Mode** per agent: `off` (the default, and the kill switch) or `suggest`. A mode `act` exists in the plan for later; the server refuses it today.
- **Limits are data** (`POST /api/agents/:id/limits`), for example the underwriting agent's `maxPremium`. A change needs no code and is audited. The underwriting agent's `maxApprovalLevel` can never go above 1: what needs a UW manager is always a person's decision.
- **Suggestions** (`SUG-0000001`) carry the kind, a summary, the reasons in words, and a proposed action. The same case is not suggested twice, and a dismissed one does not come back.
- **A person decides.** Accepting runs the proposed action **as that person**, so their authority applies (an underwriter cannot approve what needs a manager). The audit entry names the person and keeps the agent's reasons next to the decision.
- **Wake-ups.** An event wakes only the agents that listen for it, and only for the policy in it (`PolicyIssued`, `PolicyRenewed` wake the renewal agent; `PaymentMissed`, `PaymentReceived` the billing agent). A daily sweep (`AGENT_SWEEP_HOURS`, default 24, `0` = off) covers what happens because time passes. A UW manager can also run them now (`POST /api/agents/run`).
- **Customer text is never read by an agent.** They work from structured fields only, so there is nothing for a hidden instruction to hide in (the plan's safety rule 1).

## The agents

| Agent | Status | What it does | Freedom today |
|---|---|---|---|
| Renewal | built | Suggests starting the renewal of a policy whose term ends within `maxDaysBeforeEnd` (90) days. Accepting starts the renewal as the person. | Suggests |
| Keep-customers | built | Follows the lapsing and lapsed lists; suggests a renewal or lapse message by email (or WhatsApp if there is no email) unless someone was in touch within `minDaysBetweenContacts` (7) days or `maxContacts` (3) were made. | Suggests; the person sends |
| Billing | built | A late invoice (`reminderAfterDays`, 3) gets a reminder suggestion; one `escalateAfterDays` (15) late goes to a person. It never cancels: a cancellation notice always needs a person. | Suggests; the person contacts |
| Underwriting | built | For a quote or submission with issues, recommends approval when every issue is within `maxApprovalLevel`, `maxPremium` and `maxAccidents`; otherwise refers it with the reasons. Accepting approves the issues as the person. | Recommends |
| Compliance check | built | Reports a protected trait (religion, caste, gender, ...) in an agent's reason, a broken audit chain, and an agent whose suggestions are mostly dismissed. | Reports only |
| Intake, Data lookup, Quote, Issue policy, Claims intake, Customer service, Finance | planned | See `needs` in `GET /api/agents`. | — |

The planned ones wait for things the simulator does not have: incoming email and WhatsApp and a document reader (Intake), data providers (Data lookup), online payments and e-signature (Issue policy), photo upload and fraud data (Claims intake), a customer-facing channel (Customer service). Claims payments and denials stay with people whatever agents are added.

The agents are **rule-based and deterministic today**. The model each one lists (Haiku for routine work, Opus for judgment, as the plan recommends) is for a later language-model version built on the Claude Agent SDK, with this API wrapped as an MCP server. Those rules are what that version must be tested against.

## Testing before trust (the plan's safety rule 4)

`GET /api/agents/underwriting/backtest` replays the underwriting agent over past decisions and counts where it agrees with people, where it was more cautious (referred what a level-1 person approved) and where it would have gone too far (approved what a person declined). Other agents need their own backtest before they are given more freedom. The rule for widening an agent: switch it on in `suggest`, watch the acceptance rate and the compliance agent's findings for a period, backtest, and only then consider an acting mode, one agent and one kind of case at a time.

## Where a suggestion appears

A suggestion is addressed to the people whose job it is, and says so when it is created (`audience` on the record), so a
later rule change does not move work that is already waiting for someone:

| Agent | Who is told | Scope |
|---|---|---|
| Renewal, Underwriting | Underwriters and the UW manager | The whole book |
| Keep-customers, Billing | The producing agent, underwriters and the UW manager | An agent sees only their own producer code |
| Compliance check | The UW manager | The whole book |

They appear in three places: the **Desktop** (a *From the agents* card, with the reasons and a link to the case), the
**Work queues** (an *Agent suggestions for you* card), and the **AI agents → Suggestions** queue, which is still where a
suggestion is accepted or dismissed. `GET /api/suggestions/mine` is the door the two cards use: open to every signed-in
person, and it only ever returns their own. The Insurance Executive sees none, by design.

## The screens

Menu **AI agents** (UW managers and underwriters). **Suggestions**: the approval queue, filtered by Open / Accepted / Dismissed, each with its reasons; Accept shows what will happen and runs as you, Dismiss asks for an optional note. **Agents** (managers): switch each agent on or off, edit its limits, run the agents now, run the underwriting backtest, and see the planned agents and what they wait for. **Audit log** (managers): the latest 100 entries and a button that verifies the chain. Hindi and Telugu entries for the new words are in `public/i18n.js` and need the same native-speaker review as the rest.

## API (all need sign-in)

| Route | Who |
|---|---|
| `GET /api/agents`, `POST /api/agents/:id/mode`, `POST /api/agents/:id/limits`, `POST /api/agents/run`, `GET /api/agents/:id/backtest` | UW manager |
| `GET /api/agents/suggestions?status=&agent=`, `POST /api/agents/suggestions/:id/decision` `{decision: accept or dismiss, note}` | Underwriters and the UW manager |
| `GET /api/audit?limit=&action=&actor=`, `GET /api/audit/verify` | UW manager |

## The audit log

`src/audit.js`. Only ever added to. Each entry holds who (a person or an agent), what, the subject, the reasons, and the hash of the entry before it, so `GET /api/audit/verify` finds a changed or removed entry. Written for: agent mode and limit changes, every suggestion an agent makes (with its reasons), every agent run, and every accept or dismiss. The rest of the app's changes are still recorded as before (job histories); folding those into this log is not done. A backup contains the log; a restore brings back the log as it was then.

## Not done

- **Acting agents** (plan phase 4), the claims and fraud agents (phase 5), and every planned agent in the table above.
- **A payment-reminder message template** (there are renewal, lapse and claim-update templates only), so the billing agent proposes a contact for a person to make.
- **Fairness testing** across groups. The compliance agent catches a protected trait named in a reason; testing outcomes for unfair differences needs real case data.
- Language-model versions of the agents.
