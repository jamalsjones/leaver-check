(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var state = { hr: null, app: null, hrCols: {}, appCols: {}, result: null, filter: null };

  var FIELDS = {
    hr: [["id", "Employee ID"], ["email", "Email"], ["name", "Full name"], ["first", "First name"], ["last", "Last name"], ["status", "Status"], ["termDate", "Termination date"]],
    app: [["account", "Username"], ["email", "Email"], ["employeeId", "Employee ID"], ["name", "Name"], ["status", "Status"], ["lastLogin", "Last login"]],
  };
  // [filter key, count key, severity, label, test]
  var TILES = [
    ["leaver", "leaver", "high", "active accounts for people who have left", function (f) { return f.type === "leaver"; }],
    ["orphan", "orphan", "high", "accounts that match no one", function (f) { return f.type === "orphan"; }],
    ["nonperson", "nonperson", "medium", "service or shared accounts, no owner on record", function (f) { return f.type === "nonperson"; }],
    ["dormant", "dormant", "medium", "accounts unused for N+ days", function (f) { return f.type === "dormant"; }],
    ["extra", "extraAccounts", "low", "extra accounts for people with more than one", function (f) { return f.extraAccount; }],
    ["name", "nameMatches", "low", "matched on a name pattern only, to confirm", function (f) { return f.matchedOn === "username (weak)"; }],
  ];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }
  $("as-of").value = today();

  function readFile(kind, file) {
    var reader = new FileReader();
    reader.onload = function () {
      state[kind] = LeaverCheck.parseCSV(String(reader.result));
      state[kind + "Cols"] = {};
      $("name-" + kind).textContent = file.name + " · " + state[kind].rows.length + " rows";
      run();
    };
    reader.readAsText(file);
  }

  ["hr", "app"].forEach(function (kind) {
    $("file-" + kind).addEventListener("change", function (e) {
      if (e.target.files[0]) readFile(kind, e.target.files[0]);
    });
    var drop = $("drop-" + kind);
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("over");
      if (e.dataTransfer.files[0]) readFile(kind, e.dataTransfer.files[0]);
    });
  });

  $("sample").addEventListener("click", function () {
    Promise.all([fetch("examples/hr.csv").then(function (r) { return r.text(); }), fetch("examples/app.csv").then(function (r) { return r.text(); })]).then(function (t) {
      state.hr = LeaverCheck.parseCSV(t[0]);
      state.app = LeaverCheck.parseCSV(t[1]);
      state.hrCols = {};
      state.appCols = {};
      $("name-hr").textContent = "Sample: hr.csv · " + state.hr.rows.length + " people at Northpeak, an invented company";
      $("name-app").textContent = "Sample: app.csv · " + state.app.rows.length + " payroll accounts";
      $("app-name").value = "Payroll";
      $("as-of").value = "2026-11-15"; // the date the sample was written for
      run();
    });
  });

  ["app-name", "as-of", "dormant", "order"].forEach(function (id) {
    $(id).addEventListener("change", run);
  });

  function buildMap(kind, detected, headers) {
    var box = $("map-" + kind);
    box.textContent = "";
    FIELDS[kind].forEach(function (pair) {
      var f = el("div", "field");
      var id = "col-" + kind + "-" + pair[0];
      var lab = el("label", null, pair[1]);
      lab.htmlFor = id;
      var sel = el("select");
      sel.id = id;
      sel.appendChild(new Option("(none)", ""));
      headers.forEach(function (h) { sel.appendChild(new Option(h, h)); });
      sel.value = detected[pair[0]] || "";
      sel.addEventListener("change", function () {
        state[kind + "Cols"][pair[0]] = sel.value || "\u0000none";
        run();
      });
      f.appendChild(lab);
      f.appendChild(sel);
      box.appendChild(f);
    });
  }

  function run() {
    if (!state.hr || !state.app) return;
    var r = LeaverCheck.reconcile(state.hr, state.app, {
      asOf: $("as-of").value.trim() || today(),
      dormantDays: $("dormant").value,
      dateOrder: $("order").value,
      hrColumns: state.hrCols,
      appColumns: state.appCols,
    });
    state.result = r;
    $("mapping").hidden = false;
    buildMap("hr", r.columns.hr, state.hr.headers);
    buildMap("app", r.columns.app, state.app.headers);
    $("download").disabled = r.findings.length === 0;
    render();
  }

  function render() {
    var r = state.result;
    var out = $("results");
    out.textContent = "";
    out.appendChild(el("p", "label", "Findings as of " + r.asOf));
    var s = r.summary;
    out.appendChild(el("p", null, s.hrRows + " people in HR, " + s.appRows + " accounts (" + s.activeAccounts + " active), " + s.matched + " matched to a person." + (s.disabledLeavers ? " " + (s.disabledLeavers === 1 ? "1 leaver account is" : s.disabledLeavers + " leaver accounts are") + " already disabled." : "")));

    if (r.warnings.length) {
      var w = el("ul", "warnings");
      r.warnings.forEach(function (t) { w.appendChild(el("li", null, t)); });
      out.appendChild(w);
    }

    var tiles = el("div", "tiles");
    TILES.forEach(function (t) {
      var b = el("button", "tile " + t[2] + (state.filter === t[0] ? " on" : ""));
      b.type = "button";
      b.appendChild(el("b", null, String(s[t[1]])));
      var text = t[3].replace("N+", r.dormantDays + "+");
      if (t[0] === "leaver" && s.usedAfterLeaving) text += " (" + s.usedAfterLeaving + " used after they left)";
      b.appendChild(el("span", null, text));
      b.addEventListener("click", function () {
        state.filter = state.filter === t[0] ? null : t[0];
        render();
      });
      tiles.appendChild(b);
    });
    out.appendChild(tiles);

    var active = TILES.filter(function (t) { return t[0] === state.filter; })[0];
    var rows = r.findings.filter(function (f) { return !active || active[4](f); });
    if (!rows.length) {
      out.appendChild(el("p", "empty", r.findings.length ? "Nothing of this kind." : "Nothing to review. Every active account belongs to a current employee who uses it."));
      return;
    }
    var wrap = el("div", "table-wrap");
    var table = el("table");
    var head = el("tr");
    ["", "Finding", "Account", "Person", "Last login", "Left", "Detail", "Action"].forEach(function (h) { head.appendChild(el("th", null, h)); });
    var thead = el("thead");
    thead.appendChild(head);
    table.appendChild(thead);
    var tbody = el("tbody");
    rows.forEach(function (f) {
      var tr = el("tr");
      tr.appendChild(el("td", null)).appendChild(el("span", "sev " + f.severity, f.severity));
      tr.appendChild(el("td", null, LeaverCheck.label(f.type, r.dormantDays)));
      tr.appendChild(el("td", null, [f.account, f.accountEmail].filter(Boolean).join(" · ")));
      tr.appendChild(el("td", null, f.employeeName || f.employeeEmail || "-"));
      tr.appendChild(el("td", null, f.lastLogin ? f.lastLogin + (f.daysSinceLogin != null ? " (" + f.daysSinceLogin + "d)" : "") : "-"));
      tr.appendChild(el("td", null, f.terminationDate ? f.terminationDate + (f.daysSinceTermination != null && f.daysSinceTermination >= 0 ? " (" + f.daysSinceTermination + "d ago)" : "") : "-"));
      tr.appendChild(el("td", "detail", f.detail || ""));
      tr.appendChild(el("td", null, f.action));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    out.appendChild(wrap);
  }

  $("download").addEventListener("click", function () {
    if (!state.result) return;
    var app = $("app-name").value.trim();
    var csv = LeaverCheck.reviewCSV(state.result, app);
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "access-review-" + (app ? app.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" : "") + state.result.asOf + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  });
})();
