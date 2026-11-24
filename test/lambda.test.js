const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createHandler, targets, runFolder } = require(path.join(__dirname, "..", "aws", "handler.js"));
const ex = (n) => fs.readFileSync(path.join(__dirname, "..", "examples", n), "utf8");
const BUCKET = "leaver-check-123456789012-us-east-1";

/** An in-memory stand-in for the bucket. */
function memoryStore(files = {}) {
  const objects = new Map(Object.entries(files));
  const writes = [];
  return {
    objects,
    writes,
    async get(bucket, key) {
      assert.strictEqual(bucket, BUCKET);
      return objects.has(key) ? objects.get(key) : null;
    },
    async put(bucket, key, body, contentType) {
      assert.strictEqual(bucket, BUCKET);
      objects.set(key, body);
      writes.push({ key, contentType });
    },
  };
}
const quiet = { info() {} };
const s3Event = (...keys) => ({ Records: keys.map((key) => ({ s3: { bucket: { name: BUCKET }, object: { key } } })) });

test("writes the review sheet and summary once both files are in the folder", async () => {
  const store = memoryStore({
    "runs/okta-q4/hr.csv": ex("hr.csv"),
    "runs/okta-q4/app.csv": ex("app.csv"),
    "runs/okta-q4/config.json": JSON.stringify({ appName: "Okta", asOf: "2026-11-15" }),
  });
  const out = await createHandler({ store, log: quiet })(s3Event("runs/okta-q4/app.csv"));

  assert.strictEqual(out.results[0].status, "done");
  assert.deepStrictEqual(store.writes.map((w) => w.key), ["runs/okta-q4/review.csv", "runs/okta-q4/summary.json"]);
  assert.match(store.writes[0].contentType, /^text\/csv/);

  const summary = JSON.parse(store.objects.get("runs/okta-q4/summary.json"));
  assert.strictEqual(summary.appName, "Okta");
  assert.strictEqual(summary.asOf, "2026-11-15");
  const types = Object.fromEntries(summary.findings.map((f) => [f.account, f.type]));
  assert.strictEqual(types.mbyrne, "leaver");
  assert.strictEqual(types["svc-payroll-sync"], "nonperson");

  const sheet = store.objects.get("runs/okta-q4/review.csv");
  assert.match(sheet.split("\n")[0], /Decision/);
  assert.match(sheet, /mbyrne/);
});

test("the Lambda gives the same findings as the command line and browser", async () => {
  const { reconcile } = require(path.join(__dirname, "..", "skill", "leaver-check", "scripts", "leaver-check.js"));
  const direct = reconcile(ex("hr.csv"), ex("app.csv"), { asOf: "2026-11-15" });
  const store = memoryStore({
    "runs/a/hr.csv": ex("hr.csv"),
    "runs/a/app.csv": ex("app.csv"),
    "runs/a/config.json": JSON.stringify({ asOf: "2026-11-15" }),
  });
  await createHandler({ store, log: quiet })(s3Event("runs/a/hr.csv"));
  const viaLambda = JSON.parse(store.objects.get("runs/a/summary.json"));
  assert.deepStrictEqual(viaLambda.findings, JSON.parse(JSON.stringify(direct.findings)));
  assert.deepStrictEqual(viaLambda.summary, direct.summary);
});

test("waits without writing anything when only one file has arrived", async () => {
  const store = memoryStore({ "runs/b/hr.csv": ex("hr.csv") });
  const out = await createHandler({ store, log: quiet })(s3Event("runs/b/hr.csv"));
  assert.deepStrictEqual(out.results, [{ bucket: BUCKET, folder: "runs/b/", status: "waiting", missing: "app.csv" }]);
  assert.strictEqual(store.writes.length, 0);
});

test("ignores its own output, so writing results can't trigger another run", async () => {
  const store = memoryStore();
  const out = await createHandler({ store, log: quiet })(s3Event("runs/c/review.csv", "runs/c/summary.json", "runs/c/notes.txt"));
  assert.deepStrictEqual(out.results, []);
  assert.strictEqual(store.writes.length, 0);
});

test("decodes S3 event keys with spaces and special characters", () => {
  const t = targets(s3Event("runs/Q4+Okta+review%20%281%29/hr.csv"));
  assert.deepStrictEqual(t, [{ bucket: BUCKET, folder: "runs/Q4 Okta review (1)/" }]);
});

test("processes a folder once when both uploads arrive in the same event", () => {
  const t = targets(s3Event("runs/d/hr.csv", "runs/d/app.csv"));
  assert.strictEqual(t.length, 1);
});

test("can be invoked directly with a bucket and folder", async () => {
  const store = memoryStore({ "runs/e/hr.csv": ex("hr.csv"), "runs/e/app.csv": ex("app.csv") });
  const out = await createHandler({ store, log: quiet })({ bucket: BUCKET, prefix: "runs/e" });
  assert.strictEqual(out.results[0].status, "done");
  assert.ok(store.objects.has("runs/e/review.csv"));
});

test("reports a broken config.json clearly", async () => {
  const store = memoryStore({ "runs/f/hr.csv": ex("hr.csv"), "runs/f/app.csv": ex("app.csv"), "runs/f/config.json": "{not json" });
  await assert.rejects(createHandler({ store, log: quiet })(s3Event("runs/f/app.csv")), /runs\/f\/config\.json is not valid JSON/);
});

test("only hr.csv and app.csv start a run", () => {
  assert.strictEqual(runFolder("runs/x/hr.csv"), "runs/x/");
  assert.strictEqual(runFolder("runs/x/app.csv"), "runs/x/");
  assert.strictEqual(runFolder("runs/x/my-hr.csv"), null);
  assert.strictEqual(runFolder("runs/x/review.csv"), null);
});

test("logs counts only, never names or emails", async () => {
  const lines = [];
  const store = memoryStore({ "runs/g/hr.csv": ex("hr.csv"), "runs/g/app.csv": ex("app.csv") });
  await createHandler({ store, log: { info: (m) => lines.push(m) } })(s3Event("runs/g/app.csv"));
  const logged = lines.join("\n");
  assert.doesNotMatch(logged, /mbyrne|@/);
  assert.match(logged, /"leaver":\d+/);
});
