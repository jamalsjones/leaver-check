---
name: leaver-check
description: Reconcile an HR export against an application's user list to find active accounts for people who have left, accounts that match no one, service accounts with no owner, and accounts nobody uses, then write an access-review sheet and a summary for the reviewers. Use when someone has an HR or HRIS export (Workday, BambooHR, SAP and similar) and a user list from an app, directory or IdP and asks about leavers, offboarding gaps, orphaned or dormant accounts, terminated users who still have access, or preparing a user access review or certification.
---

# Leaver check

Compare who HR says works here with who can sign in to an application, and turn the gaps into an access review people can act on.

The matching is done by `scripts/leaver-check.js` in this skill's folder, a dependency-free Node script (Node 18 or later). Always use it. Don't match rows yourself: the script is deterministic, tested, and gives the same answer as the browser version of this tool, so results can be checked and repeated.

## What you need

- **HR export** (CSV): one row per person, with an employee ID or work email, plus an employment status and/or a termination date.
- **App user list** (CSV): one row per account, with a username or email, ideally a status and a last-login date.
- The **application's name**, and the **as-of date** if it isn't today.

If either file is an Excel workbook, ask the user to export the right sheet as CSV, or convert it yourself if you have a tool for that. If you only have one file, say what the other must contain and stop.

## Steps

1. **Run the script with `--json` first** to see what it found and which columns it used:

   ```bash
   node <skill-folder>/scripts/leaver-check.js --hr <hr.csv> --app <app.csv> --app-name "<App>" --json
   ```

   Add `--as-of YYYY-MM-DD` if the exports are from an earlier date, and `--dormant-days <n>` if the user's policy isn't 90 days.

2. **Check the column mapping and warnings** in the JSON (`columns` and `warnings`) before trusting any numbers.
   - If a column was missed or picked wrongly, rerun with `--hr-col field=Header` or `--app-col field=Header`. HR fields: `id, email, name, first, last, status, termDate`. App fields: `account, email, employeeId, name, status, lastLogin`.
   - If a status value wasn't recognised, tell the user which value and how it was treated, and ask what it means if it changes the result (for example "Garden leave").
   - If dates like `03/04/2026` could be either order, ask, then pass `--date-order mdy` or `dmy`.

3. **Write the review sheet** once the mapping is right:

   ```bash
   node <skill-folder>/scripts/leaver-check.js --hr <hr.csv> --app <app.csv> --app-name "<App>" --out access-review-<app>-<date>.csv
   ```

   Save it next to the input files unless the user says otherwise.

4. **Explain the findings** in plain language, most urgent first:
   - **Accounts used after the person left** (`usedAfterLeaving`): put these first. Someone signed in after the termination date, which may be misuse, a shared password, or a wrong date in HR. Recommend treating it as a possible security incident and checking the app's audit log, not just disabling the account.
   - **Leavers with active accounts** (high): how many, and the longest gap between leaving and today. Call out any where HR's status still says active but the termination date has passed, because that points to a process gap in HR, not just in this app.
   - **Accounts that match no one** (high): contractors, people who left before the HR export's window, or accounts created outside the joiner process.
   - **Service or shared accounts with no owner** (medium): matched by name only (svc, api, test, admin and similar), so say they're a guess.
   - **Dormant accounts** (medium), **extra accounts for one person** and **name-pattern matches** (low).
   - Each account appears once, under its most urgent finding, so use `summary.extraAccounts` and `summary.nameMatches` for those totals, not the `duplicate` and `weak` counts.
   - Say how matches were made (employee ID, email, or name pattern) and that name-pattern matches need a person to confirm them.

5. **Draft the access-review summary** as a Markdown file next to the sheet, using the template below. Keep it short enough for a manager to read in two minutes.

## Summary template

```markdown
# Access review: <App>, as of <date>

**Sources:** HR export <file> (<n> people); <App> user list <file> (<n> accounts, <n> active).
**Matched on:** employee ID / email / name pattern (<n> need confirming).

## What needs action

| Finding | Accounts | Action | Owner | Due |
|---|---|---|---|---|
| Used after the person left | n | Disable and check the audit log | Security | <date> |
| Active accounts for people who have left | n | Disable now | <App> admin | <date> |
| Accounts that match no one | n | Find an owner or disable | <App> owner | <date> |
| Service or shared accounts with no owner | n | Record an owner or disable | <App> owner | <date> |
| Unused for <N>+ days | n | Confirm need with manager | Managers | <date> |

## Worth knowing
- <the longest leaver gap, process gaps such as HR status lagging the termination date, data quality issues from the warnings>

## How this was done
Accounts were matched to people by <method> with the open-source leaver-check script. Name-pattern matches and service-account labels are guesses for a reviewer to confirm. Nothing was changed in <App>.
```

Leave the owner and due-date cells for the user to fill in unless they told you who and when.

## Rules

- **Recommend, never act.** Don't disable, delete or change any account, even if you have a tool that could. The review sheet has a decision column for people to fill in.
- **Keep personal data where it is.** These files hold names, emails and employment status. Read them only through the script, quote only the rows you need to explain a finding, and don't send them to any web service, search or other tool. Write outputs to local files.
- **Don't overstate.** A leaver finding means "HR says this person left and the account is enabled", not that the account was misused. Say what the data shows.
