# Bind gate — design and test matrix

The assistant may create accounts, start submissions and quote them. It may **not** bind or issue.
This document is the plan for the one remaining write path, where a mistake costs money.

## Rule

Binding requires an approval that is **re-read at execution time**. The model cannot supply a flag or a sentence
that stands in for a person's decision; it can only supply the id of a record the human changed.

## Parts

1. `request_bind_approval(job)` — creates an approval record against the job (reusing the suggestion/decision queue so
   it appears in the app and in Telegram with the same first-decision-wins rule) and returns its reference. The assistant
   then stops; nothing is issued.
2. A person decides, in the app or in Telegram.
3. `bind_policy(job, approval_id)` — refuses unless all of these hold:
   - the approval exists, is for **this** job, and its status is `approved`;
   - the approver's authority covers the quoted premium;
   - the approval is younger than the allowed window (suggest 30 minutes);
   - the approval has not already been used for a bind (single use);
   - the job is `Quoted` and has no open underwriting issues that need a person.
   On success it binds as the approver and writes an audit row naming the approval id.

## Test matrix (write these first)

| Case | Expected |
|---|---|
| approval approved, job matches, within authority | binds; audit names the approval |
| approval declined | refuses, nothing changes |
| approval missing / unknown id | refuses |
| approval belongs to another job | refuses |
| premium above the approver's authority | refuses |
| approval older than the window | refuses |
| the same approval used twice | second call refuses |
| job referred with open issues | refuses |
| assistant echoes an approval id from a previous call | refuses (single use + job match) |

## Prompt change

> You may create accounts, start submissions and quote them. Before binding or issuing anything you must call
> `request_bind_approval` and stop. Never tell the user something is bound until `bind_policy` has returned success.

## Deliberate default

Until every row above is green and deployed, `bind_policy` is not registered at all — so the assistant cannot bind,
even if asked directly. That is the state of the code today.
