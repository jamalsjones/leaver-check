# Leaver check

[![Tests](https://github.com/jamalsjones/leaver-check/actions/workflows/test.yml/badge.svg)](https://github.com/jamalsjones/leaver-check/actions/workflows/test.yml)

Compare an HR export with one application's user list and find the accounts an access review should look at first:

| Finding | Severity | What it means |
|---|---|---|
| Active account, person has left | high | HR says they left (by status or termination date) and the account is still enabled. If it was signed in to after the termination date, it's flagged and listed first. |
| No matching person | high | An active account that matches no one in HR |
| Service or shared account, no owner | medium | Unmatched, and the name looks like `svc-`, `api`, `test`, `admin` and similar |
| Unused for 90+ days | medium | A current employee's account with no sign-in for N days, or never |
| More than one account | low | One person, several active accounts; the most recently used one is left alone |
| Match needs confirming | low | Matched only by a name pattern like `dkowalski` |

It writes a review sheet (CSV) with the finding, the evidence, a recommended action, and empty **Decision**, **Reviewer** and **Notes** columns for the people doing the review.

## Four ways to run it

All four use the same script, [`skill/leaver-check/scripts/leaver-check.js`](skill/leaver-check/scripts/leaver-check.js): one file, no dependencies. The matching is identical whichever you pick.

For diagrams of the CI setup and the AWS version, the reasoning behind each design choice, and what's left before production use on AWS, see the [technical walkthrough](https://jamalsjones.github.io/leaver-check/docs/walkthrough.html) ([source](docs/walkthrough.html)).

### 1. In the browser

[jamalsjones.github.io/leaver-check](https://jamalsjones.github.io/leaver-check/). Drop in the two CSVs and download the review sheet. The files are read in the page and never uploaded. Try the sample files first.

### 2. On the command line

```bash
node skill/leaver-check/scripts/leaver-check.js --hr hr.csv --app users.csv --app-name Payroll --out review.csv
```

| Option | |
|---|---|
| `--as-of YYYY-MM-DD` | check as of this date (default today) |
| `--dormant-days 90` | unused for this many days counts as dormant; 0 turns it off |
| `--date-order mdy\|dmy` | how to read dates like `03/04/2026` |
| `--hr-col field=Header` | pick an HR column by hand (`id, email, name, first, last, status, termDate`) |
| `--app-col field=Header` | pick an app column by hand (`account, email, employeeId, name, status, lastLogin`) |
| `--fail-on high` | exit 1 if anything that severe is found, for scheduled runs |
| `--json` | print the full result |

### 3. As a Claude skill

The `skill/leaver-check` folder is an [Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview). Claude runs the script, checks the column mapping with you, explains the findings and drafts a one-page access-review summary for managers.

- **Claude Code:** copy `skill/leaver-check` to `~/.claude/skills/` (or `.claude/skills/` in a project), then ask something like "check payroll-users.csv against hr-export.csv for leavers".
- **Claude apps:** zip the `skill/leaver-check` folder and upload it as a custom skill in Claude's settings.

**About your data:** in the browser and on the command line, nothing leaves your machine. With the skill, Claude reads the script's output and whatever rows it needs to explain a finding, so names, emails and employment status pass through Claude. Use it only where your organization allows employee data to be processed by Claude, and prefer the browser or command line when it doesn't.

### 4. On AWS Lambda

`aws/` deploys Leaver check as a serverless job with the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html). Upload two files into the same folder of the bucket and the review sheet appears next to them:

```
runs/payroll-2026-q4/hr.csv         you upload
runs/payroll-2026-q4/app.csv        you upload
runs/payroll-2026-q4/config.json    optional: {"appName": "Payroll", "dormantDays": 90, "asOf": "2026-11-15"}
runs/payroll-2026-q4/review.csv     written by the function
runs/payroll-2026-q4/summary.json   written by the function: counts, warnings and every finding
```

```bash
cd aws
sam build && sam deploy --guided      # creates the bucket, function, trigger, failure queue and alarm
aws s3 cp hr.csv  s3://<BucketName>/runs/payroll-2026-q4/hr.csv
aws s3 cp app.csv s3://<BucketName>/runs/payroll-2026-q4/app.csv
aws s3 cp s3://<BucketName>/runs/payroll-2026-q4/review.csv .
```

`<BucketName>` is in the stack outputs. Each stack gets its own bucket, named `leaver-check-<account>-<region>-<stack id>`, so you can deploy more than one stack in the same account and region, for example one per application.

It runs the same `reconcile()` as the other three, so the findings are identical. Because the bucket holds employee data, the template locks it down:

- **Least privilege:** the function can read only `hr.csv`, `app.csv` and `config.json` under `runs/`, and write only `review.csv` and `summary.json`. It can't delete anything or touch other paths.
- **No public access**, bucket-owner-enforced ownership, encryption at rest, and a bucket policy that refuses anything but HTTPS.
- **Short retention:** S3 deletes everything under `runs/` after 30 days (`RetentionDays` to change it). Logs keep 30 days too, and the function logs counts only, never names or emails.
- **No loops:** only uploads named `hr.csv` or `app.csv` trigger a run, so writing results never starts another one.
- **Failures don't disappear:** a run that fails is retried twice, then its S3 event and the error go to an SQS queue (`FailedRunsQueueUrl` in the stack outputs) and are kept 14 days. A CloudWatch alarm fires on any function error. Set `AlarmEmail` when you deploy to be emailed when it does; AWS sends a confirmation email first.

You can also invoke it directly with `{"bucket": "<BucketName>", "prefix": "runs/payroll-2026-q4/"}`.

## Getting the files

- **HR:** any worker report with employee ID, work email, employment status and termination date. Include people who left during the review period, or their accounts will show up as "no matching person" instead of "has left".
- **The app:** an admin user export or a users API call, with account status and last sign-in where the app records them. Identity providers (Okta, Microsoft Entra ID and others) and most SaaS admin consoles have one.

Column names are detected from common variants (`Work Email`, `userPrincipalName`, `Last Sign In`, `accountEnabled`, `disabled` and so on). If one is missed, pick it in the page or with `--hr-col` / `--app-col`.

## How matching works

1. Employee ID, when both files have one.
2. Email, compared without case.
3. The app username against the HR email's local part and common patterns (`dkowalski`, `dana.kowalski`, `danakowalski`). These are marked as needing confirmation, and a pattern two people share is never used.

It recommends; it never changes an account.

## Make it yours

Fork it and set the defaults to your policy: the dormant threshold, which statuses mean "left", the service-account name pattern (`NONPERSON` in the script). Run the tests with `npm test` (Node 18 or later, nothing to install). To host your own copy of the page, turn on GitHub Pages for your fork.

The sample data in `examples/` is invented. Northpeak isn't a real company.

## Related

- [SAML check](https://github.com/jamalsjones/saml-check): review SAML responses, requests and metadata.
- [JWT lint](https://github.com/jamalsjones/jwt-lint) and [OIDC config check](https://github.com/jamalsjones/oidc-config-check).

## Author

Jamal Jones. Fifteen years leading enterprise identity. More at [jamalsjones.com](https://www.jamalsjones.com).

MIT licensed.
