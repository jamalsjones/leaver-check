"use strict";
/**
 * Leaver check on AWS Lambda.
 *
 * Upload two files into the same folder of the bucket:
 *   runs/<name>/hr.csv     the HR export
 *   runs/<name>/app.csv    the application's user list
 * and, optionally,
 *   runs/<name>/config.json  {"appName": "...", "asOf": "2026-11-15", "dormantDays": 90,
 *                             "dateOrder": "mdy", "hrColumns": {...}, "appColumns": {...}}
 *
 * Each upload triggers this function. Once both CSVs are present it runs the same
 * reconcile() the browser page and command line use, and writes back:
 *   runs/<name>/review.csv    the access-review sheet
 *   runs/<name>/summary.json  counts, warnings and every finding
 *
 * It can also be invoked directly with {"bucket": "...", "prefix": "runs/<name>/"}.
 */
const path = require("node:path");
const { reconcile, reviewCSV } = require(path.join(__dirname, "..", "skill", "leaver-check", "scripts", "leaver-check.js"));

const INPUTS = ["hr.csv", "app.csv"];
const CONFIG_FIELDS = ["appName", "asOf", "dormantDays", "dateOrder", "hrColumns", "appColumns"];

/** Storage backed by Amazon S3. The SDK ships with the Lambda Node.js runtime. */
function s3Store() {
  let client, sdk;
  const load = () => {
    if (!client) {
      sdk = require("@aws-sdk/client-s3");
      client = new sdk.S3Client({});
    }
    return { client, sdk };
  };
  return {
    async get(bucket, key) {
      const { client, sdk } = load();
      try {
        const res = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
        return await res.Body.transformToString("utf-8");
      } catch (e) {
        if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async put(bucket, key, body, contentType) {
      const { client, sdk } = load();
      await client.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
  };
}

/** The folder a key belongs to, if the key is one of the input files. */
function runFolder(key) {
  const name = key.split("/").pop();
  if (!INPUTS.includes(name)) return null;
  return key.slice(0, key.length - name.length);
}

/** Collect the (bucket, folder) pairs to process from an S3 event or a direct invocation. */
function targets(event) {
  if (event && event.bucket && event.prefix) {
    const prefix = event.prefix.endsWith("/") ? event.prefix : event.prefix + "/";
    return [{ bucket: event.bucket, folder: prefix }];
  }
  const seen = new Map();
  for (const rec of (event && event.Records) || []) {
    if (!rec.s3) continue;
    const bucket = rec.s3.bucket.name;
    // S3 event keys are URL-encoded, with spaces as "+".
    const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, " "));
    const folder = runFolder(key);
    if (folder !== null) seen.set(bucket + "\u0000" + folder, { bucket, folder });
  }
  return [...seen.values()];
}

function readConfig(text, folder) {
  if (!text) return {};
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${folder}config.json is not valid JSON: ${e.message}`);
  }
  const cfg = {};
  for (const k of CONFIG_FIELDS) if (raw[k] !== undefined) cfg[k] = raw[k];
  return cfg;
}

function createHandler({ store = s3Store(), log = console } = {}) {
  return async function handler(event) {
    const results = [];
    for (const { bucket, folder } of targets(event)) {
      const [hr, app, configText] = await Promise.all([
        store.get(bucket, folder + "hr.csv"),
        store.get(bucket, folder + "app.csv"),
        store.get(bucket, folder + "config.json"),
      ]);
      if (hr === null || app === null) {
        const missing = hr === null ? "hr.csv" : "app.csv";
        log.info(`Waiting for ${folder}${missing} in ${bucket}`);
        results.push({ bucket, folder, status: "waiting", missing });
        continue;
      }
      const { appName, ...options } = readConfig(configText, folder);
      const result = reconcile(hr, app, options);
      const summary = {
        asOf: result.asOf,
        appName: appName || null,
        dormantDays: result.dormantDays,
        summary: result.summary,
        warnings: result.warnings,
        findings: result.findings,
      };
      await store.put(bucket, folder + "review.csv", reviewCSV(result, appName), "text/csv; charset=utf-8");
      await store.put(bucket, folder + "summary.json", JSON.stringify(summary, null, 2), "application/json");
      const s = result.summary;
      // Log counts only. Names and emails stay in the bucket, out of CloudWatch.
      log.info(JSON.stringify({ folder, leaver: s.leaver, usedAfterLeaving: s.usedAfterLeaving, orphan: s.orphan, nonperson: s.nonperson, dormant: s.dormant }));
      results.push({ bucket, folder, status: "done", findings: result.findings.length, summary: s });
    }
    return { results };
  };
}

module.exports = { handler: createHandler(), createHandler, targets, runFolder };
