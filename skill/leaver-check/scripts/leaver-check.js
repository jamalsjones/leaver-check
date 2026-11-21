#!/usr/bin/env node
/*
 * leaver-check: compares an HR export with an application's user list and
 * finds the accounts an access review should look at first:
 *
 *   - leaver:    an active account for someone HR says has left
 *   - orphan:    an active account that matches no one in HR
 *   - nonperson: an unmatched account that looks like a service or shared one
 *   - dormant:   an active account for a current employee, unused for N days
 *   - duplicate: one person with more than one active account
 *   - weak:      matched only on a username, so a person should confirm it
 *
 * One file, no dependencies. It works three ways:
 *   - in a browser, as a plain <script> (it sets window.LeaverCheck)
 *   - in Node, as a module: const { reconcile } = require("./leaver-check.js")
 *   - in Node, as a command: node leaver-check.js --hr hr.csv --app app.csv
 *
 * It is the same script the Claude skill runs, so the matching is the same
 * whichever way you use it. It recommends; it never changes an account.
 *
 * MIT License. https://github.com/jamalsjones/leaver-check
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LeaverCheck = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- CSV ------------------------------------------------------------------

  function detectDelimiter(text) {
    var line = text.split(/\r?\n/)[0] || "";
    var best = ",";
    var bestCount = 0;
    [",", ";", "\t", "|"].forEach(function (d) {
      var n = line.split(d).length - 1;
      if (n > bestCount) {
        best = d;
        bestCount = n;
      }
    });
    return best;
  }

  function parseCSV(text) {
    text = String(text || "").replace(/^﻿/, "");
    var d = detectDelimiter(text);
    var rows = [];
    var row = [];
    var field = "";
    var quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else quoted = false;
        } else field += ch;
      } else if (ch === '"' && field === "") quoted = true;
      else if (ch === d) {
        row.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== "" || row.length) {
      row.push(field);
      if (row.length > 1 || row[0] !== "") rows.push(row);
    }
    var headers = (rows.shift() || []).map(function (h) {
      return h.trim();
    });
    var records = rows.map(function (r) {
      var o = {};
      headers.forEach(function (h, j) {
        o[h] = r[j] !== undefined ? r[j].trim() : "";
      });
      return o;
    });
    return { headers: headers, rows: records };
  }

  // Spreadsheet apps run cells that start with these characters as formulas.
  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(headers, rows) {
    return [headers.map(csvCell).join(",")]
      .concat(
        rows.map(function (r) {
          return r.map(csvCell).join(",");
        })
      )
      .join("\r\n");
  }

  // ---- Columns --------------------------------------------------------------

  function norm(h) {
    return String(h).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  var SYNONYMS = {
    hr: {
      id: ["employeeid", "empid", "employeenumber", "employeeno", "workerid", "personid", "personnelnumber", "staffid", "hrid", "id"],
      email: ["workemail", "email", "emailaddress", "businessemail", "mail", "upn", "userprincipalname", "primaryemail"],
      name: ["name", "fullname", "displayname", "employeename", "workername", "legalname"],
      first: ["firstname", "givenname", "preferredfirstname", "first"],
      last: ["lastname", "surname", "familyname", "last"],
      status: ["employmentstatus", "workerstatus", "employeestatus", "status", "active", "isactive", "state"],
      termDate: ["terminationdate", "termdate", "enddate", "lastday", "lastdayofwork", "separationdate", "leavedate", "leftdate", "exitdate"],
    },
    app: {
      account: ["username", "login", "loginname", "userid", "useridentifier", "account", "accountname", "samaccountname", "user", "handle", "id"],
      email: ["email", "emailaddress", "workemail", "mail", "upn", "userprincipalname", "primaryemail"],
      employeeId: ["employeeid", "empid", "employeenumber", "workerid", "personid", "hrid", "staffid"],
      name: ["name", "fullname", "displayname"],
      status: ["status", "accountstatus", "userstatus", "state", "enabled", "accountenabled", "active", "isactive", "disabled", "isdisabled", "suspended"],
      lastLogin: ["lastlogin", "lastlogindate", "lastloginat", "lastsignin", "lastsignindate", "lastsigninat", "lastsignindatetime", "lastactivity", "lastactive", "lastaccessed", "lastused", "lastlogon", "lastlogontimestamp", "lastseen"],
    },
  };

  function detectColumns(headers, kind, overrides) {
    var map = {};
    var byNorm = {};
    headers.forEach(function (h) {
      if (!(norm(h) in byNorm)) byNorm[norm(h)] = h;
    });
    var used = {};
    var syn = SYNONYMS[kind];
    Object.keys(syn).forEach(function (field) {
      if (overrides && overrides[field]) {
        var o = overrides[field];
        map[field] = headers.indexOf(o) !== -1 ? o : byNorm[norm(o)] || null;
        if (map[field]) used[map[field]] = true;
        return;
      }
      for (var i = 0; i < syn[field].length; i++) {
        var h = byNorm[syn[field][i]];
        if (h && !used[h]) {
          map[field] = h;
          used[h] = true;
          return;
        }
      }
      map[field] = null;
    });
    return map;
  }

  // ---- Values ---------------------------------------------------------------

  var DAY = 86400000;

  function parseDate(v, order) {
    var s = String(v || "").trim();
    if (!s || /^(never|n\/a|na|none|null|-|0)$/i.test(s)) return null;
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
    if (m) {
      var a = +m[1];
      var b = +m[2];
      var y = +m[3];
      if (y < 100) y += 2000;
      var month = a;
      var day = b;
      if (order === "dmy" || (order !== "mdy" && a > 12)) {
        month = b;
        day = a;
      }
      if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;
      return Date.UTC(y, month - 1, day);
    }
    if (/^\d{9,13}$/.test(s)) {
      var n = +s;
      return n < 1e11 ? n * 1000 : n; // Unix seconds or milliseconds
    }
    var t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  function iso(t) {
    return t === null || t === undefined || isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
  }

  var LEFT = /^(terminated|termed|term|inactive|leaver|left|separated|withdrawn|former|resigned|retired|ex|exited|offboarded|deceased|dismissed|false|no|n|0)$/i;
  var EMPLOYED = /^(active|employed|current|true|yes|y|1|on ?leave|leave|leave of absence|loa|paid ?leave|suspended|onboarding|pending|pre ?hire|contractor)$/i;
  var ACCOUNT_OFF = /^(disabled|deactivated|inactive|suspended|deprovisioned|blocked|deleted|archived|false|no|n|0|off)$/i;
  // Locked and expired-password accounts still exist and can be unlocked, so they count as active.
  var ACCOUNT_ON = /^(enabled|active|activated|true|yes|y|1|on|provisioned|staged|password ?reset|password ?expired|recovery|locked|locked ?out)$/i;

  // A column called "disabled" or "suspended" means true = off.
  function accountActive(value, column) {
    var v = String(value || "").trim().replace(/[_-]+/g, " ");
    if (!column) return { active: true, known: false };
    var inverted = /disabled|suspended/.test(norm(column));
    if (inverted) {
      if (/^(true|yes|y|1)$/i.test(v)) return { active: false, known: true };
      if (/^(false|no|n|0)$/i.test(v)) return { active: true, known: true };
    }
    if (ACCOUNT_OFF.test(v)) return { active: false, known: true };
    if (ACCOUNT_ON.test(v)) return { active: true, known: true };
    return { active: true, known: false };
  }

  var NONPERSON = /(^|[^a-z])(svc|service|system|sys|api|bot|robot|noreply|no-reply|donotreply|admin|administrator|root|test|testing|qa|demo|training|integration|sync|batch|job|scheduler|shared|team|scanner|backup|monitor|automation|app|daemon|generic|temp)([^a-z]|$)/i;

  function lower(v) {
    return String(v || "").trim().toLowerCase();
  }
  function localPart(email) {
    var e = lower(email);
    var at = e.indexOf("@");
    return at > 0 ? e.slice(0, at) : e;
  }
  function normId(v) {
    return lower(v).replace(/^0+(?=\d)/, "");
  }

  // ---- Reconcile ------------------------------------------------------------

  var SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

  var ACTIONS = {
    leaver: "Disable now. Then confirm with the manager whether anything the account owns needs to move.",
    orphan: "Find who owns it. If no one claims it within the review window, disable it.",
    nonperson: "Record a named owner and why it exists, or disable it.",
    dormant: "Ask the manager whether the access is still needed. If not, remove it.",
    duplicate: "Confirm the person needs both accounts. If not, remove the extra one.",
    weak: "Confirm this account belongs to this person. It was matched on a username only.",
  };

  function reconcile(hrInput, appInput, options) {
    var opts = options || {};
    var hr = typeof hrInput === "string" ? parseCSV(hrInput) : hrInput;
    var app = typeof appInput === "string" ? parseCSV(appInput) : appInput;
    var asOf = opts.asOf ? parseDate(opts.asOf) : Date.now();
    if (isNaN(asOf) || asOf === null) asOf = Date.now();
    asOf = Math.floor(asOf / DAY) * DAY;
    var dormantDays = opts.dormantDays != null && opts.dormantDays !== "" ? Number(opts.dormantDays) : 90;
    var order = opts.dateOrder || "auto";

    var hc = detectColumns(hr.headers, "hr", opts.hrColumns);
    var ac = detectColumns(app.headers, "app", opts.appColumns);
    var warnings = [];

    if (!hc.id && !hc.email) warnings.push("The HR file needs an employee ID or an email column to match on. None was found in: " + hr.headers.join(", ") + ".");
    if (!hc.status && !hc.termDate) warnings.push("The HR file has no status or termination date column, so leavers can't be told apart from current staff.");
    if (!ac.account && !ac.email) warnings.push("The app file needs a username or email column. None was found in: " + app.headers.join(", ") + ".");
    if (!ac.status) warnings.push("The app file has no status column, so every account is treated as active.");
    if (!ac.lastLogin) warnings.push("The app file has no last-login column, so dormant accounts can't be found.");

    // People
    var people = hr.rows.map(function (r, i) {
      var first = hc.first ? r[hc.first] : "";
      var last = hc.last ? r[hc.last] : "";
      var name = hc.name ? r[hc.name] : [first, last].join(" ").trim();
      if ((!first || !last) && name) {
        var bits = name.trim().split(/\s+/);
        if (bits.length >= 2) {
          first = first || bits[0];
          last = last || bits[bits.length - 1];
        }
      }
      var term = hc.termDate ? parseDate(r[hc.termDate], order) : null;
      var status = hc.status ? r[hc.status] : "";
      var st = status.trim().replace(/[_-]+/g, " ");
      var left = false;
      var reason = "";
      if (st && LEFT.test(st)) {
        left = true;
        reason = "status";
      }
      if (term !== null && !isNaN(term) && term < asOf + DAY) {
        if (!left) reason = "termination date";
        left = true;
      }
      if (st && !LEFT.test(st) && !EMPLOYED.test(st) && !left) {
        reason = "unknown status";
      }
      return {
        row: i + 2,
        id: hc.id ? r[hc.id] : "",
        email: hc.email ? r[hc.email] : "",
        name: name,
        first: first,
        last: last,
        status: status,
        term: term,
        left: left,
        reason: reason,
      };
    });

    var unknownStatuses = {};
    people.forEach(function (p) {
      if (p.reason === "unknown status") unknownStatuses[p.status] = (unknownStatuses[p.status] || 0) + 1;
    });
    Object.keys(unknownStatuses).forEach(function (s) {
      warnings.push("HR status \"" + s + "\" (" + unknownStatuses[s] + " people) wasn't recognised, so those people are treated as current staff.");
    });

    var byId = {};
    var byEmail = {};
    var byLocal = {};
    function addLocal(key, p) {
      if (!key) return;
      if (byLocal[key] === undefined) byLocal[key] = p;
      else if (byLocal[key] !== p) byLocal[key] = null; // null = ambiguous, never used
    }
    people.forEach(function (p) {
      if (p.id) byId[normId(p.id)] = p;
      if (p.email) {
        byEmail[lower(p.email)] = p;
        addLocal(localPart(p.email), p);
      }
      var f = lower(p.first).replace(/[^a-z]/g, "");
      var l = lower(p.last).replace(/[^a-z]/g, "");
      if (f && l) {
        // The usual username patterns: dkowalski, dana.kowalski, danakowalski, dana_kowalski, kowalskid
        [f[0] + l, f + "." + l, f + l, f + "_" + l, f[0] + "." + l, l + f[0]].forEach(function (k) {
          addLocal(k, p);
        });
      }
    });

    var unknownAccountStatuses = {};
    var accounts = app.rows.map(function (r, i) {
      var st = accountActive(ac.status ? r[ac.status] : "", ac.status);
      if (ac.status && !st.known && r[ac.status]) unknownAccountStatuses[r[ac.status]] = (unknownAccountStatuses[r[ac.status]] || 0) + 1;
      var last = ac.lastLogin ? parseDate(r[ac.lastLogin], order) : undefined;
      return {
        row: i + 2,
        account: ac.account ? r[ac.account] : "",
        email: ac.email ? r[ac.email] : "",
        employeeId: ac.employeeId ? r[ac.employeeId] : "",
        name: ac.name ? r[ac.name] : "",
        status: ac.status ? r[ac.status] : "",
        active: st.active,
        lastLogin: last,
      };
    });
    Object.keys(unknownAccountStatuses).forEach(function (s) {
      warnings.push("Account status \"" + s + "\" (" + unknownAccountStatuses[s] + " accounts) wasn't recognised, so those accounts are treated as active.");
    });

    var badDates = 0;
    accounts.forEach(function (a) {
      if (typeof a.lastLogin === "number" && isNaN(a.lastLogin)) badDates++;
    });
    if (badDates) warnings.push(badDates + " last-login values couldn't be read as dates and were treated as unknown.");

    function match(a) {
      if (a.employeeId) {
        var p = byId[normId(a.employeeId)];
        if (p) return { person: p, on: "employee ID" };
      }
      if (a.email && byEmail[lower(a.email)]) return { person: byEmail[lower(a.email)], on: "email" };
      if (a.account && byEmail[lower(a.account)]) return { person: byEmail[lower(a.account)], on: "email" };
      var candidates = [a.account, a.email].filter(Boolean).map(function (v) {
        return localPart(v);
      });
      for (var i = 0; i < candidates.length; i++) {
        var hit = byLocal[candidates[i]];
        if (hit) return { person: hit, on: "username (weak)" };
      }
      return null;
    }

    var findings = [];
    // leaver..weak count findings by their main type, one per account.
    // extraAccounts, nameMatches and usedAfterLeaving count across all findings,
    // because an account can be, say, both dormant and someone's second account.
    var counts = { hrRows: people.length, appRows: accounts.length, activeAccounts: 0, matched: 0, disabledLeavers: 0, leaver: 0, orphan: 0, nonperson: 0, dormant: 0, duplicate: 0, weak: 0, extraAccounts: 0, nameMatches: 0, usedAfterLeaving: 0 };
    var activeByPerson = {};

    function add(type, severity, a, m, extra) {
      var p = m ? m.person : null;
      var f = {
        type: type,
        severity: severity,
        account: a.account,
        accountEmail: a.email,
        accountName: a.name,
        accountStatus: a.status,
        lastLogin: a.lastLogin === undefined ? "" : a.lastLogin === null ? "never" : iso(a.lastLogin),
        daysSinceLogin: typeof a.lastLogin === "number" && !isNaN(a.lastLogin) ? Math.max(0, Math.floor((asOf - a.lastLogin) / DAY)) : null,
        employeeId: p ? p.id : "",
        employeeName: p ? p.name : "",
        employeeEmail: p ? p.email : "",
        hrStatus: p ? p.status : "",
        terminationDate: p ? iso(p.term) : "",
        daysSinceTermination: p && p.term !== null && !isNaN(p.term) ? Math.floor((asOf - p.term) / DAY) : null,
        matchedOn: m ? m.on : "",
        action: ACTIONS[type],
        detail: "",
        extraAccount: false,
        usedAfterLeaving: false,
        appRow: a.row,
      };
      if (extra) for (var k in extra) f[k] = extra[k];
      if (m && m.on === "username (weak)" && type !== "weak") {
        f.detail = (f.detail ? f.detail + " " : "") + "Matched by name pattern only, so confirm it's the same person.";
      }
      findings.push(f);
      counts[type]++;
    }

    accounts.forEach(function (a) {
      var m = match(a);
      if (m) counts.matched++;
      if (!a.active) {
        if (m && m.person.left) counts.disabledLeavers++;
        return;
      }
      counts.activeAccounts++;
      if (!m) {
        var label = [a.account, a.email, a.name].join(" ");
        if (NONPERSON.test(label)) add("nonperson", "medium", a, null);
        else add("orphan", "high", a, null);
        return;
      }
      var key = m.person.row;
      (activeByPerson[key] = activeByPerson[key] || []).push(a);
      if (m.person.left) {
        var notes = [];
        var extra = {};
        var term = m.person.term;
        if (term !== null && !isNaN(term) && typeof a.lastLogin === "number" && !isNaN(a.lastLogin) && a.lastLogin >= term + DAY) {
          var after = Math.floor((a.lastLogin - term) / DAY);
          notes.push("Signed in " + after + (after === 1 ? " day" : " days") + " after the termination date. Find out who used it.");
          extra.usedAfterLeaving = true;
          counts.usedAfterLeaving++;
        }
        if (m.person.reason === "termination date" && m.person.status) {
          notes.push("HR status still says \"" + m.person.status + "\", but the termination date has passed.");
        }
        if (notes.length) extra.detail = notes.join(" ");
        add("leaver", "high", a, m, extra);
        return;
      }
      if (ac.lastLogin && dormantDays > 0) {
        var unused = a.lastLogin === null || (typeof a.lastLogin === "number" && !isNaN(a.lastLogin) && (asOf - a.lastLogin) / DAY >= dormantDays);
        if (unused) {
          add("dormant", "medium", a, m);
          return;
        }
      }
      if (m.on === "username (weak)") add("weak", "low", a, m, { detail: "Matched " + (a.account || a.email) + " to " + (m.person.name || m.person.email) + " by name pattern only." });
    });

    Object.keys(activeByPerson).forEach(function (k) {
      var list = activeByPerson[k];
      if (list.length < 2) return;
      var person = people.filter(function (p) {
        return String(p.row) === k;
      })[0];
      if (person.left) return; // each one is already a leaver finding
      var when = function (a) {
        return typeof a.lastLogin === "number" && !isNaN(a.lastLogin) ? a.lastLogin : -Infinity;
      };
      var main = list.slice().sort(function (x, y) {
        return when(y) - when(x);
      })[0];
      var note = "One of " + list.length + " active accounts for " + (person.name || person.email) + "; the most recently used is " + (main.account || main.email) + ".";
      list.forEach(function (a) {
        if (a === main) return;
        var existing = findings.filter(function (f) {
          return f.appRow === a.row;
        })[0];
        counts.extraAccounts++;
        if (existing) {
          existing.detail = existing.detail ? existing.detail + " " + note : note;
          existing.extraAccount = true;
        } else add("duplicate", "low", a, { person: person, on: "" }, { detail: note, extraAccount: true });
      });
    });

    findings.forEach(function (f) {
      if (f.matchedOn === "username (weak)") counts.nameMatches++;
    });

    findings.sort(function (x, y) {
      if (x.usedAfterLeaving !== y.usedAfterLeaving) return x.usedAfterLeaving ? -1 : 1;
      if (SEVERITY_ORDER[x.severity] !== SEVERITY_ORDER[y.severity]) return SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity];
      if (x.type !== y.type) return x.type < y.type ? -1 : 1;
      var dx = x.daysSinceTermination != null ? x.daysSinceTermination : x.daysSinceLogin != null ? x.daysSinceLogin : -1;
      var dy = y.daysSinceTermination != null ? y.daysSinceTermination : y.daysSinceLogin != null ? y.daysSinceLogin : -1;
      return dy - dx;
    });

    return {
      asOf: iso(asOf),
      dormantDays: dormantDays,
      columns: { hr: hc, app: ac },
      warnings: warnings,
      summary: counts,
      findings: findings,
    };
  }

  var TYPE_LABEL = {
    leaver: "Active account, person has left",
    orphan: "No matching person",
    nonperson: "Service or shared account, no owner on record",
    duplicate: "Person has more than one account",
    weak: "Match needs confirming",
  };

  function label(type, dormantDays) {
    return type === "dormant" ? "Unused for " + dormantDays + "+ days" : TYPE_LABEL[type];
  }

  // The access-review sheet: findings plus empty columns for the reviewer.
  function reviewCSV(result, appName) {
    var headers = ["Application", "Finding", "Severity", "Account", "Account email", "Account status", "Last login", "Days since login", "Employee ID", "Employee name", "Employee email", "HR status", "Termination date", "Days since leaving", "Matched on", "Detail", "Recommended action", "Decision (keep / remove)", "Reviewer", "Notes"];
    var rows = result.findings.map(function (f) {
      return [appName || "", label(f.type, result.dormantDays), f.severity, f.account, f.accountEmail, f.accountStatus, f.lastLogin, f.daysSinceLogin == null ? "" : f.daysSinceLogin, f.employeeId, f.employeeName, f.employeeEmail, f.hrStatus, f.terminationDate, f.daysSinceTermination == null ? "" : f.daysSinceTermination, f.matchedOn, f.detail, f.action, "", "", ""];
    });
    return toCSV(headers, rows);
  }

  // ---- Command line ---------------------------------------------------------

  function cli(argv) {
    var fs = require("fs");
    var args = argv.slice(2);
    var o = { hrColumns: {}, appColumns: {} };
    var hrPath, appPath, outPath, appName, json = false, failOn = null;
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      var v = function () {
        return args[++i];
      };
      if (a === "--hr") hrPath = v();
      else if (a === "--app") appPath = v();
      else if (a === "--as-of") o.asOf = v();
      else if (a === "--dormant-days") o.dormantDays = Number(v());
      else if (a === "--date-order") o.dateOrder = v();
      else if (a === "--app-name") appName = v();
      else if (a === "--out") outPath = v();
      else if (a === "--json") json = true;
      else if (a === "--fail-on") failOn = v();
      else if (a === "--hr-col" || a === "--app-col") {
        var kv = v().split("=");
        (a === "--hr-col" ? o.hrColumns : o.appColumns)[kv[0]] = kv.slice(1).join("=");
      } else if (a === "-h" || a === "--help") return help();
      else {
        process.stderr.write("Unknown option " + a + "\n");
        process.exit(2);
      }
    }
    if (!hrPath || !appPath) return help(2);

    var result = reconcile(fs.readFileSync(hrPath, "utf8"), fs.readFileSync(appPath, "utf8"), o);
    if (outPath) fs.writeFileSync(outPath, reviewCSV(result, appName));

    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      var s = result.summary;
      var lines = [
        "Leaver check" + (appName ? " for " + appName : "") + ", as of " + result.asOf,
        s.hrRows + " people in HR, " + s.appRows + " accounts (" + s.activeAccounts + " active), " + s.matched + " matched to a person.",
        "",
        "  " + pad(s.leaver) + " active accounts for people who have left" + (s.usedAfterLeaving ? " (" + s.usedAfterLeaving + " used after the person left)" : ""),
        "  " + pad(s.orphan) + " active accounts that match no one",
        "  " + pad(s.nonperson) + " service or shared accounts with no owner on record",
        "  " + pad(s.dormant) + " accounts unused for " + result.dormantDays + "+ days",
        "  " + pad(s.extraAccounts) + " extra accounts for people who have more than one",
        "  " + pad(s.nameMatches) + " matches made on a name pattern only (confirm these)",
        "",
        "Each account is listed once below, under its most urgent finding.",
        "",
      ];
      result.warnings.forEach(function (w) {
        lines.push("Note: " + w);
      });
      if (result.warnings.length) lines.push("");
      result.findings.slice(0, 25).forEach(function (f) {
        var who = f.account || f.accountEmail;
        var detail = f.type === "leaver" ? (f.employeeName || f.employeeEmail) + (f.daysSinceTermination != null ? ", left " + f.daysSinceTermination + " days ago" : "") + (f.usedAfterLeaving ? ", SIGNED IN AFTER LEAVING" : "") : f.type === "dormant" ? (f.lastLogin === "never" ? "never signed in" : "last signed in " + f.lastLogin) : f.employeeName || "";
        lines.push(f.severity.toUpperCase().padEnd(7) + f.type.padEnd(10) + who + (detail ? "  (" + detail + ")" : ""));
      });
      if (result.findings.length > 25) lines.push("... and " + (result.findings.length - 25) + " more.");
      if (outPath) lines.push("", "Review sheet written to " + outPath);
      process.stdout.write(lines.join("\n") + "\n");
    }
    var fail = failOn && result.findings.some(function (f) {
      return SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[failOn];
    });
    process.exit(fail ? 1 : 0);
  }

  function pad(n) {
    return String(n).padStart(4);
  }

  function help(code) {
    process.stdout.write(
      [
        "Usage: node leaver-check.js --hr hr.csv --app users.csv [options]",
        "",
        "Finds active accounts for leavers, accounts that match no one, and",
        "accounts nobody has used, then writes a sheet for an access review.",
        "",
        "  --as-of <date>          check as of this date (default today)",
        "  --dormant-days <n>      unused for this many days counts as dormant (default 90; 0 turns it off)",
        "  --date-order mdy|dmy    how to read dates like 03/04/2026 (default: guess, US first)",
        "  --app-name <name>       the application's name, for the review sheet",
        "  --out <file.csv>        write the access-review sheet here",
        "  --hr-col field=Header   say which HR column to use (fields: id, email, name, first, last, status, termDate)",
        "  --app-col field=Header  say which app column to use (fields: account, email, employeeId, name, status, lastLogin)",
        "  --fail-on high|medium   exit 1 if any finding is this severe or worse",
        "  --json                  print the full result as JSON",
        "",
      ].join("\n")
    );
    if (code) process.exit(code);
  }

  if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    cli(process.argv);
  }

  return {
    reconcile: reconcile,
    parseCSV: parseCSV,
    reviewCSV: reviewCSV,
    detectColumns: detectColumns,
    parseDate: parseDate,
    label: label,
    cli: cli,
  };
});
