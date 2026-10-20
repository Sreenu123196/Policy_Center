# Telling a person that an agent needs a decision

An agent never acts. When it proposes something — start a renewal, contact a customer, send a payment reminder, refer an
underwriting issue — a person has to decide. This is how that person is reached when they are not looking at the app:

```
agent writes a suggestion (proposes an action)
        │
        ├─ Telegram message with the reasons and [Approve] [Dismiss]  ── tap ──┐
        │                                                                     │
        └─ no decision after ESCALATE_MINUTES (default 10)                    │
              └─ phone call: the summary is read out, press 1 / 2 ── keypress ┤
                                                                              ▼
                                                        decision runs as the approver
                                                        (their authority, in the audit log)
```

The decision is the same one the app applies: `agents.decide()` with the approver's staff record, so a manager-only action
still needs a manager, and the audit entry names the channel (`Decided from Telegram`, `Decided by phone`).

## What needs a decision

Only a suggestion with a **proposed action** is sent. The compliance agent's findings are information and stay in the app,
where they can be read in full.

## Setting it up

| Step | What to do |
|---|---|
| 1. Bot | Message **@BotFather**, `/newbot`, note the token |
| 2. Chat | Send the bot any message, then open `https://api.telegram.org/bot<token>/getUpdates` and read `chat.id` |
| 3. Secret | Make up a long random string — Telegram sends it back in `X-Telegram-Bot-Api-Secret-Token` |
| 4. Webhook | `TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… PUBLIC_URL=https://<host> node scripts/telegram-webhook.js` |
| 5. Twilio | Buy or bring a voice-capable number; note the Account SID, Auth Token and the number |
| 6. Phone | The approver's number in international form, e.g. `+9198…` |

Then set these on the server (Render → Environment) and redeploy:

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | The chat decisions may come from (any other chat is refused) |
| `TELEGRAM_WEBHOOK_SECRET` | Must equal what was registered in step 4 |
| `TELEGRAM_APPROVER` | Staff username the decision runs as; default the first UW Manager |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | The voice account and its caller ID |
| `APPROVER_PHONE` | Who is called, `+countrycode…` |
| `PUBLIC_URL` | The https address of this server, used in the TwiML action and the webhook URL |
| `ESCALATE_MINUTES` | Minutes before the call; default 10, `0` calls at once |

Without Telegram credentials nothing is sent; without Twilio the Telegram message still arrives and no call is made. The
start-up log says which half is on.

## The three doors the outside world uses

| Route | Check |
|---|---|
| `POST /api/webhooks/telegram` | `X-Telegram-Bot-Api-Secret-Token` equals `TELEGRAM_WEBHOOK_SECRET`, and the chat must be `TELEGRAM_CHAT_ID` |
| `GET /api/webhooks/twilio/voice?n=&t=` | A random token stored on that suggestion; anything else gets 404 |
| `POST /api/webhooks/twilio/decision?n=&t=` | The same token, plus Twilio's `X-Twilio-Signature` HMAC when `TWILIO_AUTH_TOKEN` is set |

All three are public in the API's own sense (no sign-in) and are listed as such in the permissions matrix. They can only
decide a suggestion that is still open, and only as the configured approver.

## What this does not do

- **One approver, not a routing table.** Everyone's decisions are the configured staff account. Multiple approvers, per
  role, is a later change.
- **No conversation.** The call reads a summary and takes one keypress. It does not answer questions; pressing 9 repeats.
- **A phone is weaker proof than a sign-in.** Anyone holding the phone can approve. Add a PIN on the call before using this
  with real money; the hook is there (`handleVoiceKeypress`).
- **The free Render instance sleeps when idle**, so a timer can only fire while the process is awake. Ten minutes is well
  inside that window in practice, but a guaranteed call needs an instance that does not sleep.
- **Costs**: a Telegram message is free; each call costs whatever the provider charges.

## Testing

`test/notifications.test.js` covers the rules with fake transports and a fake clock: what is sent, what is not, the
ten-minute escalation happening once, a decision in the app cancelling the call, the Telegram tap, the keypress, and the
signature check.
