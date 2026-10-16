# Worker contract

You execute exactly one work order (`prm.work-order/1`) and return one work report
(`prm.work-report/1`). The order is immutable: do not widen it. New feedback that arrives
while you work belongs to a later batch.

## Before changing anything

1. `cd` to `workOrder.checkout`. Run `git status`; if there are uncommitted changes you did
   not make in this batch, stop and report every finding `incomplete` with a note.
2. `git fetch` the head remote and confirm the local branch is the PR head branch
   (`pr.headRef`) and `git rev-parse HEAD` equals `pr.headSha`. If not, stop and report
   `incomplete`; the lead will re-observe.
3. Read each finding's `body`, `path`, `line`, `instructions`, and `previous` disposition.
   A previous `published` fix with a pending reply means: reply only, do not re-implement.

## Doing the work

- `task: "repair"` (needs `permissions.modifyCode`): make the smallest change that resolves
  the finding inside `baseline`. If it requires a design change (API, schema, dependency,
  architecture, security policy, behavior beyond the PR's intent), **stop all edits** and
  report the whole batch `needs_human` with the reason in `nextAction`.
- `task: "answer"`: verify the claim against current code before replying.
- Conflict batches (`conflictResolution: true`): `git merge` the pinned `pr.baseSha` into the
  head branch. Never rebase, reset, or stash user work. Ambiguous hunk -> `needs_human`.
- Run **every** command in `verification`. Any failure: do not publish; fix within scope or
  report `failed`.

## Publishing (repair mode)

1. Ask the user to approve the push and replies for this batch, unless they already approved
   this batch in this conversation.
2. Commit with a clear message. Fetch again: the remote head must still equal `pr.headSha`
   (or your own new commit on top of it). If someone else pushed, stop and report `incomplete`.
3. Push normally to the exact head repository and ref, for example
   `git push <remote-for-headRepository> HEAD:<headRef>`. Never `--force`, never push to the
   base branch, never change upstream settings to get around a mismatch.
4. Read back the pushed commit (`git ls-remote` or the provider) before reporting it.

## Replying (`permissions.reply`)

- Reply once per finding, in the **original thread**, briefly: what changed (with the commit
  SHA) or the answer. No secrets, tokens, internal URLs or security-sensitive detail.
- GitHub: `gh api` GraphQL `addPullRequestReviewThreadReply` (thread ID from the source) or a
  REST reply to the review comment. Azure DevOps: POST a comment with `parentCommentId` to the
  existing thread (see the provider docs); do not open a new thread.
- Resolve a thread only if `permissions.resolveThreads` is true and the fix or answer is visible.
- Read back each reply to get its provider ID and author for the report.

## The work report

Write JSON and run `prm report --batch <batchId> --input <file>`:

```json
{
  "schema": "prm.work-report/1",
  "batchId": "<from the work order>",
  "summary": "Fixed null handling (abc1234) and answered the naming question.",
  "mutationAttempts": 3,
  "findings": [
    {
      "sourceId": "<exact sourceId>",
      "revision": "<exact revision from the work order>",
      "outcome": "addressed",
      "stage": "replied",
      "verifiedHeadSha": "<40-hex commit you verified>",
      "repairCommit": "<40-hex>",
      "publishedCommit": "<40-hex>",
      "responseIds": ["<reply provider ID>"],
      "evidence": ["npm test passed at abc1234"]
    }
  ],
  "effects": [
    { "kind": "push", "state": "known", "commit": "<40-hex>" },
    {
      "kind": "thread_comment",
      "state": "known",
      "providerId": "<reply ID>",
      "actor": "<your login>",
      "body": "<exact reply text>"
    }
  ]
}
```

Outcomes: `addressed` (fixed or answered and published), `already_satisfied` (verified, no
change needed), `needs_human`, `failed`, `superseded` (no longer applies), `incomplete`
(started, not finished; say what remains in `nextAction`).

Stages, in order: `not_attempted`, `inspected`, `modified`, `verified`, `committed`,
`published`, `replied`, `resolved`. Report the furthest stage actually reached.

Rules the helper enforces:

- Every finding in the order appears once, with its exact `revision`.
- An `addressed` repair needs `verifiedHeadSha`, and in repair mode a `publishedCommit`
  (or stage `published` or later). An `addressed` answer needs its reply ID in `responseIds`.
- `mutationAttempts` counts every remote write you attempted (push, reply, resolve), including
  failed ones.
- Record every remote write in `effects`. Use `uncertain` when you cannot confirm the result;
  never retry an uncertain write without first checking the PR for it.
- Include the exact reply `body` and your `actor` login: the helper uses them to recognize your
  own replies on the next observation.
