# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately instead: **[Report a vulnerability](https://github.com/jamalsjones/leaver-check/security/advisories/new)**. Only you and I can see the report.

Tell me what you found, how to reproduce it (a sample input is ideal), and what you think an attacker could do with it.

I maintain this on my own, so I can't promise a fixed response time. I'll reply, keep you posted while I work on a fix, and credit you in the advisory unless you'd rather I didn't.

## Supported versions

Only the latest commit on `main`. That's also what the hosted page at [https://jamalsjones.github.io/leaver-check/](https://jamalsjones.github.io/leaver-check/) runs. Fixes aren't backported.

## In scope

- A CSV that makes the page run script, or that gets either file sent off the page (nothing is meant to leave it)
- A review sheet the tool writes that runs a formula or link when opened in a spreadsheet (CSV injection)
- The command-line tool, the Claude skill, or the AWS template in `aws/` reading or writing more than it should, or granting broader access than it needs
- A leaver with an active account who isn't flagged, when the HR export clearly marks them as gone

## Out of scope

- Name-pattern matches that are wrong. Those are flagged as needing a person to confirm, by design.
- Problems in your own HR or app exports.
