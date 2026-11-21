const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "skill", "leaver-check", "scripts", "leaver-check.js");
const { reconcile, parseCSV, reviewCSV, parseDate } = require(SCRIPT);
const ex = (n) => fs.readFileSync(path.join(__dirname, "..", "examples", n), "utf8");
const AS_OF = "2026-11-15";
const byAccount = (r) => Object.fromEntries(r.findings.map((f) => [f.account, f]));

test("the sample files give the expected findings", () => {
  const r = reconcile(ex("hr.csv"), ex("app.csv"), { asOf: AS_OF });
  const f = byAccount(r);
  assert.strictEqual(f.mbyrne.type, "leaver");
  assert.strictEqual(f.ctanaka.type, "leaver"); // status says Active, date has passed
  assert.match(f.ctanaka.detail, /termination date has passed/);
  assert.strictEqual(f.dkowalski.type, "leaver"); // no email, matched on name pattern
  assert.strictEqual(f.dkowalski.matchedOn, "username (weak)");
  assert.strictEqual(f.dkowalski.usedAfterLeaving, true); // left 08-29, signed in 09-02
  assert.match(f.dkowalski.detail, /Signed in 4 days after/);
  assert.strictEqual(f.mbyrne.usedAfterLeaving, false);
  assert.strictEqual(f.msantos.type, "orphan");
  assert.strictEqual(f["jlee.contractor"].type, "orphan");
  assert.strictEqual(f["svc-payroll-sync"].type, "nonperson");
  assert.strictEqual(f["qa-test-user"].type, "nonperson");
  assert.strictEqual(f.jachebe.type, "dormant"); // never signed in
  assert.strictEqual(f.qdelgado.type, "dormant");
  assert.strictEqual(f.jmbeki.type, "dormant"); // on leave, still employed
  assert.match(f["a.rivera"].detail, /One of 2 active accounts/);
  // Not flagged: future leaver, locked-out current employee, disabled leaver, main duplicate.
  for (const ok of ["rcosta", "tnovak", "clindqvist", "arivera", "pnair"]) assert.ok(!f[ok], ok + " should not be flagged");
  assert.strictEqual(r.summary.disabledLeavers, 1);
  assert.strictEqual(r.summary.extraAccounts, 1);
  assert.strictEqual(r.summary.nameMatches, 1);
  assert.strictEqual(r.summary.usedAfterLeaving, 1);
  assert.deepStrictEqual(r.warnings, []);
});

test("high findings sort first, longest gone first", () => {
  const r = reconcile(ex("hr.csv"), ex("app.csv"), { asOf: AS_OF });
  assert.strictEqual(r.findings[0].account, "dkowalski");
  const sev = r.findings.map((f) => f.severity);
  assert.deepStrictEqual(sev, [...sev].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)));
});

test("dormant days is configurable and 0 turns it off", () => {
  assert.strictEqual(reconcile(ex("hr.csv"), ex("app.csv"), { asOf: AS_OF, dormantDays: 0 }).summary.dormant, 0);
  assert.ok(reconcile(ex("hr.csv"), ex("app.csv"), { asOf: AS_OF, dormantDays: 3 }).summary.dormant > 4);
});

test("matching on employee ID wins over email", () => {
  const hr = "emp_id,email,status\n7,a@x.example,terminated\n8,b@x.example,active\n";
  const app = "login,mail,employee_id,enabled\nu1,b@x.example,007,true\n";
  const r = reconcile(hr, app, { asOf: AS_OF });
  assert.strictEqual(r.findings[0].type, "leaver");
  assert.strictEqual(r.findings[0].matchedOn, "employee ID");
});

test("a disabled column is read the right way round", () => {
  const hr = "email,status\na@x.example,terminated\n";
  const r1 = reconcile(hr, "email,disabled\na@x.example,true\n", { asOf: AS_OF });
  assert.strictEqual(r1.findings.length, 0);
  const r2 = reconcile(hr, "email,disabled\na@x.example,false\n", { asOf: AS_OF });
  assert.strictEqual(r2.findings[0].type, "leaver");
});

test("ambiguous name patterns are not matched", () => {
  const hr = "name,email,status\nDana Kim,dana.kim@x.example,terminated\nDev Kim,dev.kim@x.example,active\n";
  const r = reconcile(hr, "username,status\ndkim,active\n", { asOf: AS_OF });
  assert.strictEqual(r.findings[0].type, "orphan");
});

test("unknown statuses and missing columns produce warnings", () => {
  const r = reconcile("email,status\na@x.example,Garden leave\n", "email\na@x.example\n", { asOf: AS_OF });
  assert.ok(r.warnings.some((w) => /Garden leave/.test(w)));
  assert.ok(r.warnings.some((w) => /no status column/.test(w)));
  assert.ok(r.warnings.some((w) => /no last-login column/.test(w)));
});

test("column overrides", () => {
  const hr = "Person,Corp Mail,HR State\n1,a@x.example,Left\n";
  const app = "Who,State\na@x.example,on\n";
  const r = reconcile(hr, app, { asOf: AS_OF, hrColumns: { email: "Corp Mail", status: "HR State" }, appColumns: { email: "Who", status: "State" } });
  assert.strictEqual(r.findings[0].type, "leaver");
});

test("CSV parsing: quotes, embedded commas, CRLF, BOM, semicolons", () => {
  const a = parseCSV('﻿name,email\r\n"Rivera, Alex",a@x.example\r\n"Say ""hi""",b@x.example\r\n');
  assert.deepStrictEqual(a.rows[0], { name: "Rivera, Alex", email: "a@x.example" });
  assert.strictEqual(a.rows[1].name, 'Say "hi"');
  assert.strictEqual(parseCSV("a;b\n1;2\n").rows[0].b, "2");
});

test("dates", () => {
  assert.strictEqual(parseDate("2026-03-04"), Date.UTC(2026, 2, 4));
  assert.strictEqual(parseDate("03/04/2026"), Date.UTC(2026, 2, 4)); // US by default
  assert.strictEqual(parseDate("03/04/2026", "dmy"), Date.UTC(2026, 3, 3));
  assert.strictEqual(parseDate("25/04/2026"), Date.UTC(2026, 3, 25)); // day > 12, so it must be d/m
  assert.strictEqual(parseDate("never"), null);
  assert.strictEqual(parseDate("1767225600"), 1767225600000);
});

test("the review sheet blocks spreadsheet formulas", () => {
  const r = reconcile("email,status\nx@x.example,active\n", "username,status\n=HYPERLINK(\"http://evil.example\"),active\n", { asOf: AS_OF });
  const csv = reviewCSV(r, "App");
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.startsWith("Application,Finding"));
});

test("CLI writes the review sheet and honours --fail-on", () => {
  const out = path.join(require("node:os").tmpdir(), "leaver-check-test.csv");
  const args = [SCRIPT, "--hr", path.join(__dirname, "..", "examples", "hr.csv"), "--app", path.join(__dirname, "..", "examples", "app.csv"), "--as-of", AS_OF, "--out", out];
  assert.match(execFileSync("node", args).toString(), /3 active accounts for people who have left/);
  assert.strictEqual(fs.readFileSync(out, "utf8").split("\r\n").length, 12);
  assert.throws(() => execFileSync("node", [...args, "--fail-on", "high"], { stdio: "pipe" }), (e) => e.status === 1);
  fs.unlinkSync(out);
});
