/* Automatic Owner Console — all page behavior.
 *
 * The owner secret is typed into the page (never in the URL — URLs land in
 * history and screenshots) and kept in sessionStorage, or localStorage when
 * "remember on this device" is checked. Every call goes to the
 * owner-credential-checked owner_* RPCs in Cloud/schema.sql:
 *   POST {url}/rest/v1/rpc/<fn>   JSON in / JSON out
 * No library, no build step — plain fetch, mirroring app.js.
 *
 * v1.22.5 round 14 (app 1.37.9) — revamped for support. Aaron: "update the
 * owner console so i can help more if a company needs". Two tabs:
 *   Inbox      every ⚠ problem report — New / Working on it / Done, a reply
 *              that reaches the person on their Home, a private note, the
 *              screen picture when they sent one, readable errors;
 *   Companies  one row each — open reports, computers, versions in use,
 *              last seen, plan — and a company page: Overview (what needs
 *              attention), Reports, Computers, Diagnostics (with "Get fresh
 *              info now"), Projects, Activity.
 */
(function () {
  "use strict";

  var CLOUD = window.FND_CLOUD || {};
  var RPC_TIMEOUT_MS = 15000;
  var SECRET_KEY = "fnd:owner:secret";
  var INBOX_REFRESH_MS = 60000;      // new reports turn up by themselves
  var FRESH_POLL_MS = 15000;         // while waiting on "Get fresh info now"
  var FRESH_POLL_MAX = 24;           // ~6 minutes, then stop asking

  var secret = "";
  var companies = [];        // owner_list_companies payload
  var inbox = [];            // owner_list_reports payload (Inbox tab)
  var inboxFilter = "open";
  var selectedReport = null; // report id open in the Inbox panel
  var current = null;        // company open on the company page
  var co = {};               // that company's loaded parts
  var latestVersion = "";    // newest app version seen anywhere
  var tab = "inbox";
  var freshTimer = null, freshTries = 0;

  var KIND_LABELS = {
    registered:      "Registered with Automatic Cloud",
    project_shared:  "Shared a project to the cloud",
    plans_updated:   "Marked plans updated",
    plan_uploaded:   "Uploaded a plan",
    invite_sent:     "Sent an ITB invite",
    invite_viewed:   "Sub opened their invite link",
    invite_declined: "Sub declined",
    bid_submitted:   "Sub submitted a bid",
    message_gc:      "Sent a chat message",
    message_sub:     "Sub sent a chat message"
  };
  var SUB_KINDS = { invite_viewed: 1, invite_declined: 1, bid_submitted: 1, message_sub: 1 };
  var STATUS_LABELS = { "new": "New", working: "Working on it", done: "Done" };

  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------- transport

  function rpc(name, payload) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, RPC_TIMEOUT_MS);
    return fetch(CLOUD.url + "/rest/v1/rpc/" + encodeURIComponent(name), {
      method: "POST",
      headers: {
        "apikey": CLOUD.anonKey,
        "Authorization": "Bearer " + CLOUD.anonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload || {}),
      signal: ctrl.signal
    }).then(function (resp) {
      clearTimeout(timer);
      if (!resp.ok) {
        return resp.json().catch(function () { return {}; }).then(function (body) {
          var err = new Error(body.message || ("HTTP " + resp.status));
          err.unauthorized = (body.message === "unauthorized");
          err.rpcMessage = body.message || "";
          throw err;
        });
      }
      return resp.text().then(function (t) { return t ? JSON.parse(t) : {}; });
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function ownerRpc(name, payload) {
    payload = payload || {};
    payload.p_owner_secret = secret;
    return rpc(name, payload);
  }

  function failed(e, what) {
    if (e && e.unauthorized) { signOut(); return; }
    alert("Couldn't " + what + " — check your connection and try again.");
  }

  // ---------------------------------------------------------- secret store

  function loadSecret() {
    try {
      return sessionStorage.getItem(SECRET_KEY) ||
             localStorage.getItem(SECRET_KEY) || "";
    } catch (e) { return ""; }
  }
  function saveSecret(value, remember) {
    try {
      sessionStorage.setItem(SECRET_KEY, value);
      if (remember) localStorage.setItem(SECRET_KEY, value);
    } catch (e) { /* private mode — session only */ }
  }
  function clearSecret() {
    try {
      sessionStorage.removeItem(SECRET_KEY);
      localStorage.removeItem(SECRET_KEY);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ formatting

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function parseTs(iso) {
    // Postgres timestamptz::text — "T" + full offset dance, same as app.js.
    if (!iso) return null;
    var s = String(iso).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }

  function fmtDate(iso) {
    var d = parseTs(iso);
    if (!d) return "—";
    return d.toLocaleDateString(undefined,
      { month: "short", day: "numeric", year: "numeric" });
  }

  function fmtTime(iso) {
    var d = parseTs(iso);
    return d ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  }

  function fmtDateTime(iso) {
    var d = parseTs(iso);
    if (!d) return "";
    return fmtDate(iso) + ", " + fmtTime(iso);
  }

  function minutesAgo(iso) {
    var d = parseTs(iso);
    return d ? (Date.now() - d.getTime()) / 60000 : null;
  }

  function daysAgo(iso) {
    var m = minutesAgo(iso);
    return m == null ? null : m / 1440;
  }

  // "just now", "12 min ago", "3 h ago", "yesterday", "Sep 12"
  function fmtAgo(iso) {
    var m = minutesAgo(iso);
    if (m == null) return "never";
    if (m < 1.5) return "just now";
    if (m < 60) return Math.round(m) + " min ago";
    if (m < 60 * 20) return Math.round(m / 60) + " h ago";
    if (m < 60 * 40) return "yesterday";
    if (m < 60 * 24 * 7) return Math.round(m / 1440) + " days ago";
    return fmtDate(iso);
  }

  function plural(n, word, many) {
    n = Number(n) || 0;
    return n + " " + (n === 1 ? word : (many || word + "s"));
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0 MB";
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function oneLine(s, max) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  // "1.37.9" > "1.37.10"? No — compared number by number.
  function verCmp(a, b) {
    var x = String(a || "").split("."), y = String(b || "").split(".");
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var p = parseInt(x[i] || "0", 10) || 0, q = parseInt(y[i] || "0", 10) || 0;
      if (p !== q) return p < q ? -1 : 1;
    }
    return 0;
  }

  function verChip(v) {
    if (!v) return "";
    var old = latestVersion && verCmp(v, latestVersion) < 0;
    return '<span class="ver-chip' + (old ? " old" : "") + '" title="' +
      (old ? "Older than " + esc(latestVersion) : "Newest in use") + '">v' +
      esc(v) + "</span>";
  }

  function companyById(id) {
    return companies.filter(function (c) { return c.id === id; })[0] || null;
  }

  // ----------------------------------------------------------------- views

  function show(view) {
    ["view-login", "view-loading", "view-app"].forEach(function (id) {
      $(id).hidden = (id !== view);
    });
  }

  function showTab(name) {
    var changed = tab !== name;
    tab = name;
    $("tab-inbox").hidden = name !== "inbox";
    $("tab-companies").hidden = name !== "companies";
    $("tab-company").hidden = name !== "company";
    Array.prototype.forEach.call(document.querySelectorAll(".oc-tab"), function (b) {
      var t = b.getAttribute("data-tab");
      b.classList.toggle("on", t === name || (t === "companies" && name === "company"));
    });
    if (name !== "company") stopFreshPoll();
    if (changed) window.scrollTo(0, 0);
  }

  function signOut() {
    clearSecret();
    secret = "";
    companies = [];
    inbox = [];
    current = null;
    stopFreshPoll();
    $("login-secret").value = "";
    $("login-error").hidden = true;
    show("view-login");
    $("login-secret").focus();
  }

  // ----------------------------------------------------------------- stats

  function computeLatest() {
    latestVersion = "";
    companies.forEach(function (c) {
      (c.versions || []).concat(c.app_version ? [c.app_version] : [])
        .forEach(function (v) {
          if (v && (!latestVersion || verCmp(v, latestVersion) > 0)) latestVersion = v;
        });
    });
  }

  function renderStats() {
    var total = companies.length;
    var active = companies.filter(function (c) {
      var d = daysAgo(c.last_seen_at);
      return d != null && d <= 7;
    }).length;
    var paid = companies.filter(function (c) { return c.paid; }).length;
    $("stats").textContent = plural(total, "company", "companies") +
      " · " + paid + " paid · " + active + " active this week";
    $("companies-badge").textContent = String(total);
    $("companies-badge").hidden = total === 0;
  }

  // ----------------------------------------------------- problem reports
  // A report row (the list) and a report panel (beside it). Both the Inbox
  // and a company's Reports tab use them.

  function reportRow(r, showCompany, selected) {
    var row = document.createElement("button");
    row.type = "button";
    row.className = "rep-row st-" + (r.status || "new") + (selected ? " sel" : "");
    var icons = [];
    if (r.has_screenshot) icons.push('<span title="Has a screen picture">📷</span>');
    if (r.reply) {
      icons.push(r.reply_delivered_at
        ? '<span title="Reply delivered">💬</span>'
        : '<span title="Reply waiting for their app" class="pending">💬</span>');
    }
    if (r.owner_note) icons.push('<span title="Has your note">📝</span>');
    row.innerHTML =
      '<span class="dot" aria-hidden="true"></span>' +
      '<span class="rep-main">' +
      '<span class="rep-l1">' +
      (showCompany ? "<strong>" + esc(r.company_name || r.fnd_company_id || "(company)") +
                     "</strong> · " : "") +
      esc(r.area || "—") + "</span>" +
      '<span class="rep-l2">' + esc(oneLine(r.what, 140)) + "</span>" +
      '<span class="rep-l3">' + esc(r.reporter || "Someone") +
      (r.app_version ? " · v" + esc(r.app_version) : "") + "</span>" +
      "</span>" +
      '<span class="rep-side">' +
      '<span class="rep-when">' + esc(fmtAgo(r.reported_at || r.created_at)) + "</span>" +
      '<span class="rep-icons">' + icons.join("") + "</span>" +
      "</span>";
    return row;
  }

  function reportPanel(r, opts) {
    // opts: {showCompany, onChanged(r), onOpenCompany}
    var box = document.createElement("div");
    box.className = "rd";
    var errs = Array.isArray(r.errors) ? r.errors : [];
    var name = r.reporter || "them";
    var first = name.split(" ")[0];
    var meta = [esc(r.reporter || "Someone"),
                esc(fmtDateTime(r.reported_at || r.created_at)),
                r.app_version ? "v" + esc(r.app_version) : "",
                esc(r.machine || "")].filter(Boolean).join(" · ");
    var replyState = "";
    if (r.reply) {
      replyState = '<div class="rd-sent"><p class="rd-sent-text">' + esc(r.reply) + "</p>" +
        '<p class="rd-sent-meta">Sent ' + esc(fmtDateTime(r.replied_at)) + " · " +
        (r.reply_delivered_at
          ? '<span class="ok">On their Home since ' + esc(fmtTime(r.reply_delivered_at)) + "</span>"
          : '<span class="wait">Waiting for their app — it picks it up within a minute or two of being open</span>') +
        "</p></div>";
    }
    box.innerHTML =
      '<div class="rd-head">' +
      '<div class="rd-titles">' +
      (opts.showCompany
        ? '<p class="rd-company"><a href="#" class="rd-co-link">' +
          esc(r.company_name || r.fnd_company_id || "(company)") + "</a></p>" : "") +
      "<h3>" + esc(r.area || "—") + "</h3>" +
      '<p class="rd-meta">' + meta + "</p></div>" +
      '<div class="seg small rd-status" role="group" aria-label="Status">' +
      ["new", "working", "done"].map(function (s) {
        return '<button type="button" data-s="' + s + '"' +
          (r.status === s ? ' class="on"' : "") + ">" + STATUS_LABELS[s] + "</button>";
      }).join("") + "</div></div>" +
      '<p class="rd-what">' + esc(r.what || "") + "</p>" +
      (r.has_screenshot
        ? '<button type="button" class="rd-shot" title="Open full size">' +
          '<span class="rd-shot-wait">Loading the picture…</span></button>' : "") +
      '<div class="rd-block">' +
      "<h4>Reply to " + esc(first) + "</h4>" + replyState +
      '<textarea class="rd-reply" rows="3" maxlength="4000" placeholder="' +
      (r.reply ? "Send a new reply…" : "Type your answer…") + '"></textarea>' +
      '<div class="rd-row"><button type="button" class="btn btn-primary rd-send" disabled>' +
      (r.reply ? "Send new reply" : "Send reply") + "</button>" +
      '<span class="hint">Shows on ' + esc(first) +
      "'s Home under Recent Updates.</span></div></div>" +
      '<div class="rd-block">' +
      "<h4>Your private note</h4>" +
      '<textarea class="rd-note" rows="2" maxlength="4000" placeholder="Only you see this…">' +
      esc(r.owner_note || "") + "</textarea>" +
      '<div class="rd-row"><button type="button" class="btn btn-outline rd-save" disabled>Save note</button>' +
      '<span class="hint rd-note-state"></span></div></div>' +
      (errs.length
        ? group("Errors from their app", String(errs.length), renderErrors(errs), true)
        : '<p class="hint">No error messages came with this report.</p>');

    var link = box.querySelector(".rd-co-link");
    if (link) {
      link.addEventListener("click", function (ev) {
        ev.preventDefault();
        var c = companyById(r.company_id);
        if (c) openCompany(c, "reports", r.id);
      });
    }

    Array.prototype.forEach.call(box.querySelectorAll(".rd-status button"), function (b) {
      b.addEventListener("click", function () {
        var s = b.getAttribute("data-s");
        if (s === r.status) return;
        setBusy(box, true);
        ownerRpc("owner_set_report_status", { p_report_id: r.id, p_status: s })
          .then(function () {
            r.status = s;
            opts.onChanged(r);
          }).catch(function (e) { setBusy(box, false); failed(e, "change the status"); });
      });
    });

    var reply = box.querySelector(".rd-reply"), send = box.querySelector(".rd-send");
    reply.addEventListener("input", function () { send.disabled = !reply.value.trim(); });
    send.addEventListener("click", function () {
      var text = reply.value.trim();
      if (!text) return;
      send.disabled = true;
      ownerRpc("owner_reply_report", { p_report_id: r.id, p_reply: text })
        .then(function () {
          r.reply = text;
          r.replied_at = new Date().toISOString();
          r.reply_delivered_at = null;
          if (r.status === "new") r.status = "working";
          opts.onChanged(r);
        }).catch(function (e) { send.disabled = false; failed(e, "send the reply"); });
    });

    var note = box.querySelector(".rd-note"), save = box.querySelector(".rd-save");
    var noteState = box.querySelector(".rd-note-state");
    note.addEventListener("input", function () {
      save.disabled = note.value.trim() === (r.owner_note || "").trim();
      noteState.textContent = "";
    });
    save.addEventListener("click", function () {
      var text = note.value.trim();
      save.disabled = true;
      ownerRpc("owner_set_report_note", { p_report_id: r.id, p_note: text })
        .then(function () {
          r.owner_note = text;
          noteState.textContent = "Saved ✓";
          opts.onChanged(r, true);
        }).catch(function (e) { save.disabled = false; failed(e, "save the note"); });
    });

    if (r.has_screenshot) loadShot(r, box.querySelector(".rd-shot"));
    return box;
  }

  function setBusy(box, busy) {
    Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) {
      b.disabled = busy;
    });
  }

  var shotCache = {};
  function loadShot(r, btn) {
    function put(src) {
      if (!btn.isConnected) return;
      if (!src) { btn.innerHTML = '<span class="rd-shot-wait">The picture couldn\'t be loaded.</span>'; return; }
      btn.innerHTML = '<img alt="The app window when the report was sent" src="' + src + '">';
      btn.onclick = function () {
        $("shot-img").src = src;
        $("shot-modal").hidden = false;
      };
    }
    // The panel is built before it is placed on the page, so even a cached
    // picture waits a tick — `put` skips a button that isn't on screen.
    if (shotCache[r.id]) { setTimeout(function () { put(shotCache[r.id]); }, 0); return; }
    ownerRpc("owner_report_screenshot", { p_report_id: r.id }).then(function (res) {
      var src = res && res.image ? "data:image/jpeg;base64," + res.image : "";
      if (src) shotCache[r.id] = src;
      put(src);
    }).catch(function (e) {
      if (e.unauthorized) { signOut(); return; }
      put("");
    });
  }

  // ------------------------------------------------------------- the inbox

  function inboxMatches(r) {
    if (inboxFilter === "open" && r.status === "done") return false;
    if (inboxFilter !== "open" && inboxFilter !== "all" && r.status !== inboxFilter) return false;
    var q = $("inbox-search").value.trim().toLowerCase();
    if (!q) return true;
    return [r.company_name, r.fnd_company_id, r.reporter, r.area, r.what,
            r.machine, r.owner_note, r.reply]
      .join(" ").toLowerCase().indexOf(q) >= 0;
  }

  function renderInbox() {
    var list = $("inbox-list");
    list.innerHTML = "";
    var shown = inbox.filter(inboxMatches);
    var newCount = inbox.filter(function (r) { return r.status === "new"; }).length;
    $("inbox-badge").textContent = String(newCount);
    $("inbox-badge").hidden = newCount === 0;
    $("inbox-split").hidden = shown.length === 0;
    $("inbox-empty").hidden = shown.length > 0;
    $("inbox-empty").textContent = inbox.length
      ? "Nothing here with this filter."
      : "No problem reports yet. When someone presses ⚠ in the app, what " +
        "they wrote shows up here.";
    if (!shown.some(function (r) { return r.id === selectedReport; })) {
      selectedReport = shown.length ? shown[0].id : null;
    }
    shown.forEach(function (r) {
      var row = reportRow(r, true, r.id === selectedReport);
      row.addEventListener("click", function () {
        selectedReport = r.id;
        renderInbox();
        if (window.innerWidth < 900) $("inbox-detail").scrollIntoView({ behavior: "smooth" });
      });
      list.appendChild(row);
    });
    var detail = $("inbox-detail");
    detail.innerHTML = "";
    var r = shown.filter(function (x) { return x.id === selectedReport; })[0];
    if (r) {
      detail.appendChild(reportPanel(r, {
        showCompany: true,
        onChanged: function (changed, quiet) {
          if (!quiet) renderInbox();
          refreshCompanyCounts();
        }
      }));
    }
  }

  function loadInbox() {
    return ownerRpc("owner_list_reports", {
      p_status: null, p_company_id: null, p_limit: 500
    }).then(function (data) {
      inbox = Array.isArray(data) ? data : [];
      renderInbox();
    }).catch(function (e) {
      if (e.unauthorized) { signOut(); return; }
      $("inbox-list").innerHTML = '<p class="empty">Couldn\'t load problem reports.</p>';
    });
  }

  function refreshCompanyCounts() {
    // Counts on the Companies tab follow the Inbox without a full reload.
    companies.forEach(function (c) {
      var mine = inbox.filter(function (r) { return r.company_id === c.id; });
      if (!mine.length && !c.open_reports) return;
      c.open_reports = mine.filter(function (r) { return r.status !== "done"; }).length;
      c.new_reports = mine.filter(function (r) { return r.status === "new"; }).length;
    });
    renderCompanies();
  }

  // --------------------------------------------------------- companies tab

  function renderCompanies() {
    var q = $("search").value.trim().toLowerCase();
    var list = $("company-list");
    list.innerHTML = "";
    $("list-empty").hidden = companies.length > 0;
    $("co-table").hidden = companies.length === 0;
    companies.filter(function (c) {
      if (!q) return true;
      return [c.name, c.fnd_company_id, c.owner_note].join(" ")
        .toLowerCase().indexOf(q) >= 0;
    }).forEach(function (c) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "co-row";
      var days = daysAgo(c.last_seen_at);
      var reports = Number(c.open_reports) || 0;
      var versions = (c.versions && c.versions.length ? c.versions
                      : (c.app_version ? [c.app_version] : []))
        .slice().sort(verCmp).reverse();
      row.innerHTML =
        '<span class="co-name"><span class="co-title">' + esc(c.name || "(unnamed)") + "</span>" +
        '<span class="co-sub mono">' + esc(c.fnd_company_id || "") + "</span>" +
        (c.owner_note ? '<span class="co-note">📝 ' + esc(oneLine(c.owner_note, 90)) + "</span>" : "") +
        "</span>" +
        '<span class="co-cell" data-label="Reports">' +
        (reports ? '<span class="badge ' + (c.new_reports ? "stale" : "quiet") + '">' +
                   reports + " open</span>" : '<span class="muted">—</span>') + "</span>" +
        '<span class="co-cell" data-label="Computers">' +
        (Number(c.machine_count) ? esc(String(c.machine_count)) : '<span class="muted">—</span>') +
        "</span>" +
        '<span class="co-cell" data-label="Versions">' +
        (versions.length ? versions.map(verChip).join(" ") : '<span class="muted">—</span>') +
        "</span>" +
        '<span class="co-cell' + (days != null && days > 30 ? " quiet-text" : "") +
        '" data-label="Last seen">' + esc(fmtAgo(c.last_seen_at)) + "</span>" +
        '<span class="co-cell" data-label="Plan">' +
        (c.paid ? '<span class="badge paid">Paid</span>'
                : '<span class="badge free">Free / locked</span>') + "</span>";
      row.addEventListener("click", function () { openCompany(c, "overview"); });
      list.appendChild(row);
    });
  }

  function refreshAll(showSpinner) {
    if (showSpinner) show("view-loading");
    return ownerRpc("owner_list_companies").then(function (data) {
      companies = Array.isArray(data) ? data : [];
      computeLatest();
      renderStats();
      renderCompanies();
      show("view-app");
      return loadInbox();
    }).then(function () {
      if (tab === "company" && current) {
        var fresh = companyById(current.id);
        if (!fresh) { showTab("companies"); current = null; return; }
        openCompany(fresh, co.sub || "overview", co.selected);
      }
    }).catch(function (e) {
      if (e && e.unauthorized) {
        signOut();
        $("login-error").textContent =
          "That secret wasn't accepted — check it and try again.";
        $("login-error").hidden = false;
      } else {
        show("view-app");
        alert("Couldn't reach the backend — check your connection and try again.");
      }
    });
  }

  // ----------------------------------------------------------- company page

  function openCompany(c, sub, reportId) {
    current = Object.assign({}, c);
    co = { sub: sub || "overview", reports: null, machines: null, diag: null,
           projects: null, activity: null, selected: reportId || null };
    renderCompanyCard();
    ["d-reports", "d-report-detail", "d-computers", "d-diag", "d-projects",
     "d-activity", "co-overview"].forEach(function (id) { $(id).innerHTML = ""; });
    ["n-reports", "n-computers", "n-projects"].forEach(function (id) { $(id).textContent = ""; });
    if (tab !== "company") window.scrollTo(0, 0);
    showTab("company");
    showSub(co.sub);
    var id = c.id;
    function mine() { return current && current.id === id; }

    ownerRpc("owner_company_detail", { p_company_id: id }).then(function (data) {
      if (!mine()) return;
      if (data && data.company) {
        current = Object.assign({}, current, data.company);
        renderCompanyCard();
      }
      co.projects = (data && data.projects) || [];
      renderProjects();
      renderOverview();
    }).catch(handleCompanyError);

    ownerRpc("owner_list_reports", { p_status: null, p_company_id: id, p_limit: 200 })
      .then(function (data) {
        if (!mine()) return;
        co.reports = Array.isArray(data) ? data : [];
        renderCompanyReports();
        renderOverview();
      }).catch(handleCompanyError);

    ownerRpc("owner_company_machines", { p_company_id: id }).then(function (data) {
      if (!mine()) return;
      co.machines = Array.isArray(data) ? data : [];
      renderComputers();
      renderOverview();
    }).catch(handleCompanyError);

    loadDiagnostics();

    ownerRpc("owner_company_activity", { p_company_id: id, p_limit: 200 })
      .then(function (events) {
        if (!mine()) return;
        co.activity = Array.isArray(events) ? events : [];
        renderActivity();
      }).catch(handleCompanyError);
  }

  function handleCompanyError(e) {
    if (e && e.unauthorized) { signOut(); return; }
    if (e && e.rpcMessage === "unknown company") {
      // deleted from another tab/device — fall back to the list
      current = null;
      showTab("companies");
      refreshAll(false);
      return;
    }
    failed(e, "load that");
  }

  function showSub(name) {
    co.sub = name;
    ["overview", "reports", "computers", "diag", "projects", "activity"].forEach(function (s) {
      $("co-" + s).hidden = s !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll("#co-tabs button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-sub") === name);
    });
  }

  function renderCompanyCard() {
    var c = current;
    $("crumb-name").textContent = c.name || "(unnamed)";
    $("d-name").textContent = c.name || "(unnamed)";
    $("d-fnd").textContent = c.fnd_company_id || "";
    $("d-created").textContent = fmtDate(c.created_at);
    $("d-seen").textContent = c.last_seen_at ? fmtAgo(c.last_seen_at) : "never";
    var badge = $("d-paid");
    badge.textContent = c.paid ? "Paid" : "Free / locked";
    badge.className = "badge " + (c.paid ? "paid" : "free");
    $("btn-paid").textContent = c.paid
      ? "Switch to free (lock)" : "Switch to paid (unlock)";
    $("d-note").textContent = c.owner_note || "";
    $("d-note").hidden = !c.owner_note;
    renderFreshStatus();
  }

  // ---- overview: what needs attention, in one place

  function renderOverview() {
    var box = $("co-overview");
    var c = current;
    var reps = co.reports || [];
    var open = reps.filter(function (r) { return r.status !== "done"; });
    var machines = co.machines || [];
    var snap = co.diag && co.diag.snapshot;
    var users = snap && snap.users ? (snap.users.count || 0) : null;
    var items = [];
    if (open.length) {
      items.push(["warn", plural(open.length, "open problem report") +
        " — newest: “" + oneLine(open[0].what, 90) + "”", "reports"]);
    }
    var src = machines.filter(function (m) { return m.build === "source"; });
    if (src.length) {
      items.push(["warn", plural(src.length, "computer") + " running from source, not the " +
        "built app (" + src.map(function (m) { return m.label || m.machine_id; }).join(", ") +
        ")", "computers"]);
    }
    var old = machines.filter(function (m) {
      return latestVersion && m.app_version && verCmp(m.app_version, latestVersion) < 0 &&
        daysAgo(m.last_seen) < 30;
    });
    if (old.length) {
      items.push(["info", plural(old.length, "computer") + " on an older version than " +
        latestVersion, "computers"]);
    }
    var crashes = snap && Array.isArray(snap.recent_errors) ? snap.recent_errors.length : 0;
    if (crashes) items.push(["warn", plural(crashes, "crash", "crashes") +
      " in their latest diagnostics", "diag"]);
    if (co.diag && co.diag.updated_at && daysAgo(co.diag.updated_at) > 7) {
      items.push(["info", "Diagnostics are " + Math.round(daysAgo(co.diag.updated_at)) +
        " days old — Get fresh info now", "diag"]);
    }
    var facts = [
      ["Open reports", co.reports ? String(open.length) : "…", "reports"],
      ["Computers", co.machines ? String(machines.length) : "…", "computers"],
      ["Users", users == null ? "—" : String(users), "diag"],
      ["Diagnostics", co.diag ? (co.diag.updated_at ? fmtAgo(co.diag.updated_at) : "none") : "…", "diag"],
      ["Projects shared", co.projects ? String(co.projects.length) : "…", "projects"],
      ["Last seen", c.last_seen_at ? fmtAgo(c.last_seen_at) : "never", "activity"]
    ];
    box.innerHTML =
      '<div class="facts">' + facts.map(function (f) {
        return '<button type="button" class="fact" data-go="' + f[2] + '">' +
          '<span class="fact-n">' + esc(f[1]) + '</span><span class="fact-l">' +
          esc(f[0]) + "</span></button>";
      }).join("") + "</div>" +
      '<h3 class="section-title">Needs attention</h3>' +
      (items.length
        ? '<div class="attn">' + items.map(function (it) {
            return '<button type="button" class="attn-item ' + it[0] + '" data-go="' +
              it[2] + '">' + esc(it[1]) + '<span class="attn-go">›</span></button>';
          }).join("") + "</div>"
        : '<p class="empty-card">Nothing needs attention. ✓</p>');
    Array.prototype.forEach.call(box.querySelectorAll("[data-go]"), function (b) {
      b.addEventListener("click", function () { showSub(b.getAttribute("data-go")); });
    });
  }

  // ---- reports

  function renderCompanyReports() {
    var reps = co.reports || [];
    $("n-reports").textContent = reps.filter(function (r) { return r.status !== "done"; }).length || "";
    var list = $("d-reports");
    list.innerHTML = "";
    $("d-reports-empty").hidden = reps.length > 0;
    list.parentNode.hidden = reps.length === 0;
    if (!reps.some(function (r) { return r.id === co.selected; })) {
      co.selected = reps.length ? reps[0].id : null;
    }
    reps.forEach(function (r) {
      var row = reportRow(r, false, r.id === co.selected);
      row.addEventListener("click", function () {
        co.selected = r.id;
        renderCompanyReports();
      });
      list.appendChild(row);
    });
    var detail = $("d-report-detail");
    detail.innerHTML = "";
    var r = reps.filter(function (x) { return x.id === co.selected; })[0];
    if (r) {
      detail.appendChild(reportPanel(r, {
        showCompany: false,
        onChanged: function (changed, quiet) {
          // keep the Inbox's copy in step
          inbox = inbox.map(function (x) { return x.id === changed.id ? changed : x; });
          if (!quiet) { renderCompanyReports(); renderOverview(); }
          renderInbox();
          refreshCompanyCounts();
        }
      }));
    }
  }

  // ---- computers

  function renderComputers() {
    var list = co.machines || [];
    $("n-computers").textContent = list.length || "";
    var box = $("d-computers");
    $("d-computers-empty").hidden = list.length > 0;
    if (!list.length) { box.innerHTML = ""; return; }
    box.innerHTML =
      '<div class="pc-table"><div class="pc-head" aria-hidden="true"><span>Computer</span>' +
      "<span>Signed in</span><span>Version</span><span>Runs</span><span>System</span>" +
      "<span>Last seen</span><span></span></div>" +
      list.map(function (m, i) {
        var build = m.build === "source"
          ? '<span class="badge stale" title="Python running the code, not the built app">from source</span>'
          : (m.build === "exe" ? '<span class="badge quiet">Automatic.exe</span>'
             : (m.build === "app" ? '<span class="badge quiet">Automatic.app</span>' : "—"));
        return '<div class="pc-row' + (daysAgo(m.last_seen) > 30 ? " gone" : "") + '">' +
          '<span class="pc-name" data-label="Computer"><strong>' + esc(m.label || "(unnamed)") +
          '</strong><span class="mono pc-folder" title="Where the app runs from">' +
          esc(m.app_folder || "") + "</span></span>" +
          '<span data-label="Signed in">' + esc(m.last_user || "—") + "</span>" +
          '<span data-label="Version">' + (m.app_version ? verChip(m.app_version) : "—") + "</span>" +
          '<span data-label="Runs">' + build + "</span>" +
          '<span data-label="System">' + esc(m.os || "—") +
          (m.python ? '<span class="pc-py">Python ' + esc(m.python) + "</span>" : "") + "</span>" +
          '<span data-label="Last seen" title="' + esc(fmtDateTime(m.last_seen)) + '">' +
          esc(fmtAgo(m.last_seen)) + '<span class="pc-first">since ' + esc(fmtDate(m.first_seen)) +
          "</span></span>" +
          '<span><button type="button" class="oc-link pc-forget" data-i="' + i +
          '" title="Remove from this list — it comes back if it runs the app again">Forget</button></span>' +
          "</div>";
      }).join("") + "</div>";
    Array.prototype.forEach.call(box.querySelectorAll(".pc-forget"), function (b) {
      b.addEventListener("click", function () {
        var m = list[Number(b.getAttribute("data-i"))];
        if (!m || !confirm("Forget " + (m.label || "this computer") + "?\n\nIt comes " +
            "back by itself if it runs Automatic again.")) return;
        ownerRpc("owner_forget_machine", { p_company_id: current.id, p_machine_id: m.machine_id })
          .then(function () {
            co.machines = list.filter(function (x) { return x !== m; });
            renderComputers();
            renderOverview();
          }).catch(function (e) { failed(e, "forget that computer"); });
      });
    });
  }

  // ---- diagnostics + "Get fresh info now"

  function loadDiagnostics() {
    var id = current && current.id;
    if (!id) return Promise.resolve();
    return ownerRpc("owner_company_diagnostics", { p_company_id: id }).then(function (data) {
      if (!current || current.id !== id) return;
      co.diag = data || {};
      if (co.diag.diag_requested_at) current.diag_requested_at = co.diag.diag_requested_at;
      renderDiagnostics();
      renderFreshStatus();
      renderOverview();
    }).catch(handleCompanyError);
  }

  function freshWaiting() {
    var asked = current && parseTs(current.diag_requested_at);
    if (!asked) return false;
    var got = co.diag && parseTs(co.diag.updated_at);
    return !got || got < asked;
  }

  function renderFreshStatus() {
    var el = $("fresh-status");
    if (!current || !current.diag_requested_at) { el.hidden = true; return; }
    el.hidden = false;
    if (freshWaiting()) {
      var mins = minutesAgo(current.diag_requested_at);
      el.className = "fresh-status wait";
      el.textContent = "Asked for fresh info " + fmtAgo(current.diag_requested_at) +
        " — waiting for their app. It answers within a minute or two while " +
        "Automatic is open on any of their computers." +
        (mins != null && mins > 15 ? " (Nobody may have it open right now.)" : "");
    } else {
      el.className = "fresh-status ok";
      el.textContent = "Fresh info arrived " + fmtAgo(co.diag.updated_at) +
        " from " + (co.diag.machine || "their app") + ".";
    }
  }

  function stopFreshPoll() {
    if (freshTimer) clearTimeout(freshTimer);
    freshTimer = null;
    freshTries = 0;
  }

  function pollFresh() {
    stopFreshPoll();
    function tick() {
      freshTimer = null;
      if (!current || tab !== "company" || !freshWaiting() || freshTries >= FRESH_POLL_MAX) return;
      freshTries += 1;
      loadDiagnostics().then(function () {
        if (freshWaiting()) freshTimer = setTimeout(tick, FRESH_POLL_MS);
        else {
          // the snapshot landed — its machine list and users are new too
          ownerRpc("owner_company_machines", { p_company_id: current.id }).then(function (m) {
            co.machines = Array.isArray(m) ? m : [];
            renderComputers();
            renderOverview();
          }).catch(function () { /* next refresh */ });
        }
      });
    }
    freshTimer = setTimeout(tick, FRESH_POLL_MS);
  }

  var ROLE_NAMES = { Lvl1: "Lvl 1", Lvl2: "Lvl 2", Lvl3: "Lvl 3", Admin: "Admin" };

  function kvTable(obj, order) {
    var keys = order || Object.keys(obj || {});
    var rows = keys.filter(function (k) {
      return obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "";
    }).map(function (k) {
      var v = obj[k];
      if (typeof v === "boolean") v = v ? "yes" : "no";
      else if (Array.isArray(v)) v = v.join(", ");
      else if (typeof v === "object") v = JSON.stringify(v);
      return "<tr><td>" + esc(k.replace(/_/g, " ")) + "</td>" +
        '<td class="mono">' + esc(String(v)) + "</td></tr>";
    }).join("");
    return rows ? '<table class="kv">' + rows + "</table>"
                : '<p class="empty">—</p>';
  }

  function group(title, chip, innerHtml, open) {
    return '<details class="diag-group"' + (open ? " open" : "") + ">" +
      "<summary>" + esc(title) +
      (chip ? '<span class="diag-chip">' + esc(chip) + "</span>" : "") +
      '</summary><div class="diag-body">' + innerHtml + "</div></details>";
  }

  function renderUsers(u) {
    if (!u || u._error) return '<p class="empty">unavailable</p>';
    var head = "<p><strong>" + esc(String(u.count || 0)) + "</strong> active" +
      (u.archived ? " · " + esc(String(u.archived)) + " archived" : "") + "</p>";
    var rows = (u.roster || []).map(function (m) {
      var role = m.role || "?";
      var pill = '<span class="role-pill' +
        (role === "Admin" ? " admin" : "") + '">' +
        esc(ROLE_NAMES[role] || role) + "</span>";
      var name = ((m.first_name || "") + " " + (m.last_name || "")).trim()
        || m.email || "(unnamed)";
      return '<tr class="' + (m.is_active === false ? "u-off" : "") + '">' +
        "<td>" + esc(name) + "</td>" +
        "<td>" + esc(m.email || "") + "</td>" +
        "<td>" + pill + "</td>" +
        "<td>" + esc(m.company_title || "") + "</td>" +
        "<td>" + (m.all_projects ? "all" : "scoped") + "</td></tr>";
    }).join("");
    return head + '<table class="users-tbl"><tr><th>Name</th><th>Email</th>' +
      "<th>Role</th><th>Title</th><th>Projects</th></tr>" + rows + "</table>";
  }

  function renderErrors(errs) {
    if (!Array.isArray(errs) || !errs.length) {
      return '<p class="empty">No recent errors logged. 🎉</p>';
    }
    // Crashes first, then everything else; newest first within each. A
    // crash is marked, so it stands out from the handled lines.
    var list = errs.slice().reverse();
    list = list.filter(function (e) { return /^CRASH: /.test(String(e)); })
      .concat(list.filter(function (e) { return !/^CRASH: /.test(String(e)); }));
    return '<div class="err-list">' + list.map(function (e) {
      var s = String(e);
      var crash = /^CRASH: /.test(s);
      return '<div class="err-item' + (crash ? " crash" : "") + '">' +
        (crash ? '<span class="err-tag">Crash</span>' : "") +
        esc(crash ? s.slice(7) : s) + "</div>";
    }).join("") + "</div>";
  }

  function renderHandled(list) {
    if (!Array.isArray(list) || !list.length) return '<p class="empty">None.</p>';
    return '<div class="err-list">' + list.map(function (h) {
      return '<div class="err-item handled"><span class="err-tag quiet">×' +
        esc(String(h.count || 1)) + "</span>" + esc(h.message || "") + "</div>";
    }).join("") + "</div>";
  }

  function renderDiagnostics() {
    var data = co.diag || {};
    var snap = data.snapshot;
    var box = $("d-diag");
    if (!snap) {
      box.innerHTML = "";
      $("d-diag-empty").hidden = false;
      return;
    }
    $("d-diag-empty").hidden = true;
    var parts = [];
    var sub = snap.contractor_type ? (" · " + snap.contractor_type) : "";
    parts.push('<p class="diag-updated">Snapshot from <span class="mono">' +
      esc(data.machine || snap.machine || "?") + "</span> · " +
      esc(fmtDateTime(data.updated_at)) + " (" + esc(fmtAgo(data.updated_at)) + ")" +
      (data.app_version ? " · app v" + esc(data.app_version) + sub : "") +
      "</p>");
    var errCount = Array.isArray(snap.recent_errors) ? snap.recent_errors.length : 0;
    parts.push(group("Crashes", errCount ? String(errCount) : "",
      renderErrors((snap.recent_errors || []).map(function (e) { return "CRASH: " + e; })),
      errCount > 0));
    var handled = Array.isArray(snap.recent_handled) ? snap.recent_handled : [];
    parts.push(group("Handled errors (most frequent today)", handled.length ? String(handled.length) : "",
      renderHandled(handled), false));
    parts.push(group("Users",
      snap.users ? String(snap.users.count || 0) : "",
      renderUsers(snap.users), false));
    parts.push(group("Company profile", "", kvTable(snap.company_profile), false));
    parts.push(group("Folder names", "",
      snap.folder_names && snap.folder_names.ordered
        ? kvTable({ order: snap.folder_names.ordered,
                    custom: snap.folder_names.custom }) : '<p class="empty">—</p>',
      false));
    parts.push(group("Building types",
      Array.isArray(snap.building_types) ? String(snap.building_types.length) : "",
      Array.isArray(snap.building_types) && snap.building_types.length
        ? '<p class="mono small-mono">' + esc(snap.building_types.join(", ")) + "</p>"
        : '<p class="empty">—</p>', false));
    parts.push(group("ITB settings", "", kvTable(snap.itb_settings), false));
    parts.push(group("File Document", "", kvTable(snap.file_document), false));
    parts.push(group("Project defaults", "", kvTable(snap.project_defaults), false));
    parts.push(group("Cloud / storage / activity", "",
      kvTable(Object.assign({}, snap.cloud_settings, snap.storage,
                            snap.activity_log)), false));
    box.innerHTML = parts.join("");
  }

  // ---- projects + activity

  function renderProjects() {
    var projects = co.projects || [];
    $("n-projects").textContent = projects.length || "";
    var box = $("d-projects");
    box.innerHTML = "";
    $("d-projects-empty").hidden = projects.length > 0;
    projects.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "project-row";
      var meta = [
        "shared " + fmtDate(p.created_at),
        plural(p.plan_count, "plan") + " (" + fmtBytes(p.plan_bytes) + ")",
        plural(p.invite_count, "invite") +
          (p.revoked_invite_count > 0
            ? " (" + p.revoked_invite_count + " revoked)" : ""),
        plural(p.bid_count, "bid"),
        plural(p.message_count, "message")
      ].join(" · ");
      row.innerHTML =
        '<p class="company-name">' + esc(p.name || p.project_key) + "</p>" +
        '<p class="company-meta">' + esc(meta) +
        (p.plans_updated_at
          ? " · plans updated " + esc(fmtDate(p.plans_updated_at)) : "") +
        "</p>";
      box.appendChild(row);
    });
  }

  function renderActivity() {
    var events = co.activity || [];
    var box = $("d-activity");
    box.innerHTML = "";
    $("d-activity-empty").hidden = events.length > 0;
    events.forEach(function (ev) {
      var item = document.createElement("div");
      item.className = "tl-item" + (SUB_KINDS[ev.kind] ? " sub" : "");
      item.innerHTML =
        '<p class="tl-kind">' + esc(KIND_LABELS[ev.kind] || ev.kind) + "</p>" +
        (ev.detail ? '<p class="tl-detail">' + esc(ev.detail) + "</p>" : "") +
        '<p class="tl-when">' + esc(fmtDateTime(ev.at)) + "</p>";
      box.appendChild(item);
    });
  }

  // -------------------------------------------------------------- actions

  $("btn-fresh").addEventListener("click", function () {
    if (!current) return;
    var btn = $("btn-fresh");
    btn.disabled = true;
    ownerRpc("owner_request_diagnostics", { p_company_id: current.id })
      .then(function (res) {
        current.diag_requested_at = (res && res.requested_at) || new Date().toISOString();
        renderFreshStatus();
        showSub("diag");
        pollFresh();
      }).catch(function (e) { failed(e, "ask for fresh info"); })
      .finally(function () { btn.disabled = false; });
  });

  $("btn-paid").addEventListener("click", function () {
    if (!current) return;
    var next = !current.paid;
    if (!next && !confirm(
        "Lock " + (current.name || current.fnd_company_id) + "?\n\n" +
        "Their File Bid / Projects / Check Bids / PDF Tools show the " +
        "Automatic Pro card after their next license check. Nothing is " +
        "deleted — flipping back restores everything.")) {
      return;
    }
    var btn = $("btn-paid");
    btn.disabled = true;
    ownerRpc("owner_set_paid", { p_company_id: current.id, p_paid: next })
      .then(function () {
        current.paid = next;
        companies = companies.map(function (row) {
          return row.id === current.id ? Object.assign({}, row, { paid: next }) : row;
        });
        renderCompanyCard();
        renderStats();
        renderCompanies();
      }).catch(function (e) { failed(e, "change the paid flag"); })
      .finally(function () { btn.disabled = false; });
  });

  $("btn-note").addEventListener("click", function () {
    if (!current) return;
    $("note-input").value = current.owner_note || "";
    $("note-modal").hidden = false;
    $("note-input").focus();
  });
  $("note-cancel").addEventListener("click", function () {
    $("note-modal").hidden = true;
  });
  $("note-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!current) return;
    var note = $("note-input").value.trim();
    ownerRpc("owner_set_note", { p_company_id: current.id, p_note: note })
      .then(function () {
        current.owner_note = note;
        companies = companies.map(function (row) {
          return row.id === current.id ? Object.assign({}, row, { owner_note: note }) : row;
        });
        $("note-modal").hidden = true;
        renderCompanyCard();
        renderCompanies();
      }).catch(function (e) { failed(e, "save the note"); });
  });

  $("btn-delete").addEventListener("click", function () {
    if (!current) return;
    $("delete-fnd").textContent = current.fnd_company_id || "";
    $("delete-confirm").value = "";
    $("delete-error").hidden = true;
    $("delete-form").querySelector("button[type=submit]").disabled = true;
    $("delete-modal").hidden = false;
    $("delete-confirm").focus();
  });
  $("delete-cancel").addEventListener("click", function () {
    $("delete-modal").hidden = true;
  });
  $("delete-confirm").addEventListener("input", function () {
    $("delete-form").querySelector("button[type=submit]").disabled =
      this.value.trim() !== (current && current.fnd_company_id);
  });
  $("delete-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!current) return;
    ownerRpc("owner_delete_company", {
      p_company_id: current.id,
      p_confirm: $("delete-confirm").value.trim()
    }).then(function (res) {
      $("delete-modal").hidden = true;
      var folders = []
        .concat(((res && res.plans_folders) || []).map(function (f) { return "plans/" + f; }))
        .concat(((res && res.bids_folders) || []).map(function (f) { return "bids/" + f; }));
      if (folders.length) {
        alert("Deleted. Their PDFs are now unreachable; to reclaim the " +
          "storage bytes, remove these folders in Dashboard → Storage:\n\n" +
          folders.join("\n"));
      }
      current = null;
      showTab("companies");
      refreshAll(false);
    }).catch(function (e) {
      if (e.unauthorized) { signOut(); return; }
      $("delete-error").textContent =
        e.rpcMessage === "confirm mismatch"
          ? "That doesn't match the Company ID."
          : "Delete failed — check your connection and try again.";
      $("delete-error").hidden = false;
    });
  });

  // ------------------------------------------------------- create company

  var lastCreated = null;

  $("add-company").addEventListener("click", function () {
    $("create-fnd").value = "";
    $("create-name").value = "";
    $("create-paid").checked = true;
    $("create-error").hidden = true;
    $("create-modal").hidden = false;
    $("create-fnd").focus();
  });
  $("create-cancel").addEventListener("click", function () {
    $("create-modal").hidden = true;
  });
  $("create-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var fnd = $("create-fnd").value.trim();
    if (!fnd) {
      $("create-error").textContent = "A Company ID is required.";
      $("create-error").hidden = false;
      return;
    }
    ownerRpc("owner_create_company", {
      p_fnd_company_id: fnd,
      p_name: $("create-name").value.trim(),
      p_paid: $("create-paid").checked
    }).then(function (res) {
      $("create-modal").hidden = true;
      lastCreated = res || {};
      $("secret-fnd").textContent = lastCreated.fnd_company_id || fnd;
      $("secret-val").textContent = lastCreated.gc_secret || "";
      $("secret-modal").hidden = false;
      refreshAll(false);
    }).catch(function (e) {
      if (e.unauthorized) { signOut(); return; }
      $("create-error").textContent = e.rpcMessage === "company exists"
        ? "That Company ID already exists."
        : "Couldn't create the company — check your connection and try again.";
      $("create-error").hidden = false;
    });
  });
  $("secret-copy").addEventListener("click", function () {
    if (!lastCreated) return;
    var text = "Company ID: " + (lastCreated.fnd_company_id || "") +
      "\nSecret: " + (lastCreated.gc_secret || "");
    try {
      navigator.clipboard.writeText(text);
      $("secret-copy").textContent = "Copied ✓";
      setTimeout(function () { $("secret-copy").textContent = "Copy both"; }, 1500);
    } catch (e) { /* clipboard blocked — the values are on screen to copy by hand */ }
  });
  $("secret-done").addEventListener("click", function () {
    $("secret-modal").hidden = true;
    lastCreated = null;
  });

  $("shot-close").addEventListener("click", function () { $("shot-modal").hidden = true; });
  $("shot-modal").addEventListener("click", function (ev) {
    if (ev.target === $("shot-modal")) $("shot-modal").hidden = true;
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") $("shot-modal").hidden = true;
  });

  // ----------------------------------------------------------------- boot

  $("login-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var value = $("login-secret").value.trim();
    if (value.length < 16) {
      $("login-error").textContent =
        "The owner secret is at least 16 characters.";
      $("login-error").hidden = false;
      return;
    }
    secret = value;
    saveSecret(value, $("login-remember").checked);
    $("login-error").hidden = true;
    refreshAll(true);
  });

  $("sign-out").addEventListener("click", function (ev) {
    ev.preventDefault();
    signOut();
  });
  $("back-link").addEventListener("click", function (ev) {
    ev.preventDefault();
    current = null;
    showTab("companies");
    renderCompanies();
  });
  Array.prototype.forEach.call(document.querySelectorAll(".oc-tab"), function (b) {
    b.addEventListener("click", function () {
      var t = b.getAttribute("data-tab");
      if (t === "companies") current = null;
      showTab(t);
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("#inbox-filter button"), function (b) {
    b.addEventListener("click", function () {
      inboxFilter = b.getAttribute("data-f");
      Array.prototype.forEach.call(document.querySelectorAll("#inbox-filter button"),
        function (x) { x.classList.toggle("on", x === b); });
      renderInbox();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("#co-tabs button"), function (b) {
    b.addEventListener("click", function () { showSub(b.getAttribute("data-sub")); });
  });
  $("inbox-search").addEventListener("input", renderInbox);
  $("search").addEventListener("input", renderCompanies);
  $("refresh").addEventListener("click", function () { refreshAll(false); });

  // New reports turn up without a click — quietly, while the page is shown.
  function hasDraft() {
    // A reply or note typed and not yet sent — never redraw over it.
    return Array.prototype.some.call(
      document.querySelectorAll(".rd-reply, .rd-note, #inbox-search"),
      function (t) {
        if (t.id === "inbox-search") return document.activeElement === t;
        return t.classList.contains("rd-reply") ? !!t.value.trim()
          : t.value.trim() !== (t.defaultValue || "").trim();
      });
  }
  setInterval(function () {
    if (!secret || document.hidden || $("view-app").hidden || tab !== "inbox") return;
    if (hasDraft()) return;
    loadInbox();
  }, INBOX_REFRESH_MS);

  function boot() {
    if (!CLOUD.url || !CLOUD.anonKey) {
      show("view-login");
      $("login-error").textContent = "config.js is missing the backend address.";
      $("login-error").hidden = false;
      return;
    }
    secret = loadSecret();
    showTab("inbox");
    if (secret) {
      refreshAll(true);
    } else {
      show("view-login");
      $("login-secret").focus();
    }
  }

  boot();
})();
