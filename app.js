/* Automatic sub portal (v1.15) — all page behavior.
 *
 * The invite token comes from the URL hash (#<token>) and is the sub's only
 * credential. Every call goes to the token-checked RPCs in Cloud/schema.sql:
 *   POST {url}/rest/v1/rpc/<fn>                      JSON in / JSON out
 *   GET/POST {url}/storage/v1/object/<bucket>/<path> PDF bytes (grant-gated)
 * No library, no build step — plain fetch, mirroring the desktop app's
 * system/cloud_client.py.
 */
(function () {
  "use strict";

  var CLOUD = window.FND_CLOUD || {};
  var RPC_TIMEOUT_MS = 10000;
  var FILE_TIMEOUT_MS = 120000;
  var MAX_BID_BYTES = 25 * 1024 * 1024; // mirror of the `bids` bucket cap

  // Trade names for the header chips — mirrors Config.py CSI_DIVISIONS.
  //
  // v1.22.4 round 12: regenerated from Config so the two can't drift. It had
  // gone stale — ten divisions missing (a sub invited to Div 40 saw a bare
  // number) and two titles wrong against the published standard.
  //
  // **CSI ONLY — and now only a FALLBACK.** A company on the NAHB set numbers
  // its divisions 1-10 by build order, so resolving those through this table
  // told a sub bidding "5 Rough Structure" that they were bidding "5 Metals".
  // Fixed in v1.22.5: the invite carries `division_labels` (the GC's own trade
  // names for its own codes) and `divisionChip` prefers them. This table is
  // what an older invite, which has no labels, still falls back to.
  var CSI_NAMES = {
    0: "Procurement and Contracting Requirements",
    1: "General Requirements",
    2: "Existing Conditions",
    3: "Concrete",
    4: "Masonry",
    5: "Metals",
    6: "Wood, Plastics, and Composites",
    7: "Thermal and Moisture Protection",
    8: "Openings",
    9: "Finishes",
    10: "Specialties",
    11: "Equipment",
    12: "Furnishings",
    13: "Special Construction",
    14: "Conveying Equipment",
    21: "Fire Suppression",
    22: "Plumbing",
    23: "HVAC",
    25: "Integrated Automation",
    26: "Electrical",
    27: "Communications",
    28: "Electronic Safety and Security",
    31: "Earthwork",
    32: "Exterior Improvements",
    33: "Utilities",
    34: "Transportation",
    35: "Waterway and Marine Construction",
    40: "Process Interconnections",
    41: "Material Processing and Handling Equipment",
    42: "Process Heating, Cooling, and Drying Equipment",
    43: "Process Gas and Liquid Handling and Storage",
    44: "Pollution and Waste Control Equipment",
    45: "Industry-Specific Manufacturing Equipment",
    46: "Water and Wastewater Equipment",
    48: "Electrical Power Generation"
  };

  var token = (location.hash || "").replace(/^#/, "").trim();
  var project = null;          // sub_get_project payload
  var chosenFile = null;       // File selected for Submit Bid
  var msgTimer = null;         // 45s refresh while Messages tab is open

  function $(id) { return document.getElementById(id); }

  // localStorage is namespaced per token so two invites on one phone
  // don't share names/visit markers.
  var STORE_PREFIX = "auto:";
  var LEGACY_STORE_PREFIX = "fnd:";   // pre-rename; read once, then carried over
  function storeKey(suffix, prefix) {
    return (prefix || STORE_PREFIX) + token.slice(0, 12) + ":" + suffix;
  }
  function storeGet(suffix) {
    try {
      var v = localStorage.getItem(storeKey(suffix));
      if (v === null) {
        // A sub who opened this page before the rename has their name and
        // last-visit marker under the old prefix. Carry it over instead of
        // making them retype their name and see every file as new again.
        v = localStorage.getItem(storeKey(suffix, LEGACY_STORE_PREFIX));
        if (v !== null) { localStorage.setItem(storeKey(suffix), v); }
      }
      return v;
    } catch (e) { return null; }
  }
  function storeSet(suffix, value) {
    try { localStorage.setItem(storeKey(suffix), value); } catch (e) { /* private mode */ }
  }

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
          throw err;
        });
      }
      return resp.text().then(function (t) { return t ? JSON.parse(t) : {}; });
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function storagePath(bucket, path) {
    // keep the / separators, encode everything else (mirrors urllib.parse.quote)
    return CLOUD.url + "/storage/v1/object/" +
      encodeURIComponent(bucket) + "/" +
      encodeURIComponent(path).replace(/%2F/gi, "/");
  }

  function fetchFile(bucket, path) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, FILE_TIMEOUT_MS);
    return fetch(storagePath(bucket, path), {
      headers: { "apikey": CLOUD.anonKey, "Authorization": "Bearer " + CLOUD.anonKey },
      signal: ctrl.signal
    }).then(function (resp) {
      clearTimeout(timer);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.blob();
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function uploadFile(bucket, path, file) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, FILE_TIMEOUT_MS);
    return fetch(storagePath(bucket, path), {
      method: "POST",
      headers: {
        "apikey": CLOUD.anonKey,
        "Authorization": "Bearer " + CLOUD.anonKey,
        "Content-Type": "application/pdf",
        "x-upsert": "true"
      },
      body: file,
      signal: ctrl.signal
    }).then(function (resp) {
      clearTimeout(timer);
      if (!resp.ok) throw new Error("upload failed (HTTP " + resp.status + ")");
      return true;
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  // ------------------------------------------------------------ formatting

  function esc(s) {
    // v1.22.5 round 5 — quotes too. textContent->innerHTML escapes < > &
    // only, and a value placed inside an attribute (data-code="…") could
    // otherwise close the attribute and add its own.
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Trades read low to high (9, 23, 28) — a text sort put 28 before 9.
  function byCode(a, b) {
    var x = parseFloat(a), y = parseFloat(b);
    if (isNaN(x) || isNaN(y)) return String(a).localeCompare(String(b));
    return x - y || String(a).localeCompare(String(b));
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(iso);
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.toLocaleDateString(undefined,
      { month: "short", day: "numeric", year: "numeric" });
  }

  function parseTs(iso) {
    // Postgres timestamptz::text looks like "2026-07-13 10:00:00+00" —
    // V8 needs "T" and a full "+00:00" offset or it returns Invalid Date
    // (which silently killed the plans banner + message times).
    if (!iso) return null;
    var s = String(iso).replace(" ", "T")
      .replace(/([+-]\d{2})$/, "$1:00");
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }

  function fmtDateTime(iso) {
    var d = parseTs(iso);
    if (!d) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function fmtSize(bytes) {
    var n = Number(bytes);
    if (!n || n <= 0) return "";
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function divisionChip(code) {
    // The GC's own label wins (v1.22.5). Only the contractor knows which
    // category system they run — CSI, NAHB, or their own custom names — so the
    // invite now carries the trade names it was sent with, and this page shows
    // what the GC actually meant.
    //
    // This is the fix for a real defect: a contractor on the NAHB set invited
    // a sub to bid "5 Rough Structure" and this function told them "5 Metals",
    // because it resolved every number through the CSI table below. Wrong
    // trade name, to the person about to price it.
    //
    // The CSI table stays as the fallback: invites sent before v1.22.5 carry
    // no labels, and for the CSI companies that is the correct answer anyway.
    var labels = (project && project.division_labels) || {};
    var sent = labels[String(code)];
    if (sent) return "Div " + code + " — " + sent;
    var name = CSI_NAMES[parseInt(code, 10)];
    return name ? ("Div " + code + " — " + name) : ("Div " + code);
  }

  // ----------------------------------------------------------------- boot

  function showError() {
    $("view-loading").hidden = true;
    $("view-app").hidden = true;
    $("view-error").hidden = false;
  }

  function boot() {
    if (!CLOUD.url || !CLOUD.anonKey || !token || token.length < 16) {
      showError();
      return;
    }
    rpc("sub_get_project", { p_token: token }).then(function (data) {
      project = data || {};
      renderHeader();
      renderBidDivisions();
      $("view-loading").hidden = true;
      $("view-app").hidden = false;
      loadPlans();
      startPlansRefresh();
    }).catch(function (e) {
      if (e.unauthorized) {
        showError();
      } else {
        // network hiccup, not a dead token — say so and offer a retry
        showError();
        $("error-detail").textContent =
          "We couldn't reach the server just now. Check your connection " +
          "and reload this page — the link itself may be fine.";
      }
    });
  }

  function renderHeader() {
    $("gc-name").textContent = project.gc_name || "your contractor";
    $("project-name").textContent = project.project_name || "Project";
    document.title = (project.project_name || "Bid Portal") + " — Automatic";
    $("due-date").textContent =
      project.due_date ? ("Bids due " + fmtDate(project.due_date)) : "";
    var chips = $("divisions");
    chips.innerHTML = "";
    (project.divisions || []).slice().sort(byCode).forEach(function (code) {
      var span = document.createElement("span");
      span.className = "chip";
      span.textContent = divisionChip(code);
      chips.appendChild(span);
    });
    if (project.welcome_text) {
      $("welcome-text").textContent = project.welcome_text;
      $("welcome-text").hidden = false;
    }
    document.querySelectorAll(".success-gc").forEach(function (el) {
      el.textContent = project.gc_name || "the contractor";
    });
    if (project.status === "declined") $("declined-note").hidden = false;
  }

  // ----------------------------------------------------------------- tabs

  var tabs = { plans: "tab-plans", messages: "tab-messages", bid: "tab-bid" };
  var panes = { plans: "pane-plans", messages: "pane-messages", bid: "pane-bid" };

  function showTab(which) {
    Object.keys(tabs).forEach(function (k) {
      var active = (k === which);
      $(tabs[k]).classList.toggle("active", active);
      $(tabs[k]).setAttribute("aria-selected", active ? "true" : "false");
      $(panes[k]).hidden = !active;
    });
    if (which === "messages") {
      loadMessages();
      if (!msgTimer) msgTimer = setInterval(loadMessages, 45000);
    } else if (msgTimer) {
      clearInterval(msgTimer);
      msgTimer = null;
    }
  }

  $("tab-plans").addEventListener("click", function () { showTab("plans"); });
  $("tab-messages").addEventListener("click", function () { showTab("messages"); });
  $("tab-bid").addEventListener("click", function () { showTab("bid"); });

  // ---------------------------------------------------------------- plans

  // v1.22.5 round 4 — the plans list must never go stale on an open page.
  // Listing a plan is what grants the page 15 minutes to download it
  // (sub_list_plans -> _fnd_mint_grant), and the GC can publish or pull a
  // sheet at any time. The page used to list once at load, so after a quarter
  // of an hour — or after the GC changed what is public — a click failed
  // until the sub re-opened the email. Aaron: "we cant just have the refresh
  // work, instead of sub having to." So: re-list when the page comes back
  // into view, every few minutes while it is open, before opening anything
  // from a list older than PLANS_STALE_MS, and once more if an open fails.
  var PLANS_STALE_MS = 10 * 60 * 1000;
  var PLANS_POLL_MS = 3 * 60 * 1000;
  var plansLoadedAt = 0;
  var plansTimer = null;

  function loadPlans() {
    return rpc("sub_list_plans", { p_token: token }).then(function (plans) {
      plans = Array.isArray(plans) ? plans : [];
      plansLoadedAt = Date.now();
      var list = $("plans-list");
      list.innerHTML = "";
      $("plans-empty").hidden = plans.length > 0;
      plans.forEach(function (p) {
        var row = document.createElement("div");
        row.className = "plan-row";
        // v1.16.2 — drawing revision + plan date lead the meta line
        // ("Rev 2 — Jul 1, 2026"). Older rows without a rev just skip it.
        var rev = (p.rev == null) ? "" :
          ("Rev " + p.rev + (p.plan_date ? " — " + fmtDate(p.plan_date) : ""));
        var meta = [rev, fmtSize(p.size_bytes), fmtDate(p.uploaded_at)]
          .filter(Boolean).join(" · ");
        row.innerHTML =
          '<div class="plan-info">' +
          '<p class="plan-name">' + esc(p.filename) + "</p>" +
          '<p class="plan-meta">' + esc(meta) + "</p></div>" +
          '<div class="plan-actions">' +
          '<button class="btn btn-outline" data-act="view">View</button>' +
          '<button class="btn btn-outline" data-act="dl">Download</button></div>';
        row.querySelector('[data-act="view"]').addEventListener("click", function () {
          openPlan(p, false, this);
        });
        row.querySelector('[data-act="dl"]').addEventListener("click", function () {
          openPlan(p, true, this);
        });
        list.appendChild(row);
      });
      maybeShowPlansBanner();
      storeSet("lastVisit", new Date().toISOString());
      return plans;
    }).catch(function () {
      $("plans-empty").textContent =
        "Couldn't load the plans list — check your connection and reload.";
      $("plans-empty").hidden = false;
      return null;
    });
  }

  function startPlansRefresh() {
    if (!plansTimer) plansTimer = setInterval(function () {
      if (!document.hidden) loadPlans();
    }, PLANS_POLL_MS);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && plansLoadedAt &&
        Date.now() - plansLoadedAt > 30 * 1000) {
      loadPlans();
    }
  });

  // The row as the portal lists it NOW — the same sheet may have a new path
  // (a new Rev) since the list on screen was drawn.
  function currentPlan(p, plans) {
    var found = null;
    (plans || []).forEach(function (q) {
      if (!found && q.filename === p.filename) found = q;
    });
    return found;
  }

  function maybeShowPlansBanner() {
    // Yellow "plans changed" banner. plans_updated_at is set by the GC app
    // starting at v1.16.2 — until then this stays dormant.
    var updated = parseTs(project && project.plans_updated_at);
    var last = parseTs(storeGet("lastVisit"));
    if (!updated || !last) return;
    if (updated > last) {
      $("plans-updated-date").textContent =
        fmtDate(project.plans_updated_at);
      $("plans-banner").hidden = false;
    }
  }

  function openPlan(p, download, btn) {
    var original = btn.textContent;
    btn.textContent = "…";
    btn.disabled = true;
    var gone = false;
    var fresh = (Date.now() - plansLoadedAt < PLANS_STALE_MS)
      ? Promise.resolve(p)
      : loadPlans().then(function (plans) {
          return plans ? currentPlan(p, plans) : p;
        });
    fresh.then(function (row) {
      if (!row) { gone = true; throw new Error("gone"); }
      return fetchFile(row.bucket || "plans", row.path).catch(function () {
        // One quiet retry through a fresh list: the grant may have run out,
        // or the GC may have replaced the sheet since this list was drawn.
        return loadPlans().then(function (plans) {
          var again = plans ? currentPlan(p, plans) : null;
          if (!again) { gone = true; throw new Error("gone"); }
          return fetchFile(again.bucket || "plans", again.path);
        });
      });
    }).then(function (blob) {
      var url = URL.createObjectURL(
        new Blob([blob], { type: "application/pdf" }));
      if (download) {
        var a = document.createElement("a");
        a.href = url;
        a.download = p.filename || "plan.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        var win = window.open(url, "_blank");
        if (!win) {
          // popup blocked (common on phones) — fall back to download
          var a2 = document.createElement("a");
          a2.href = url;
          a2.download = p.filename || "plan.pdf";
          document.body.appendChild(a2);
          a2.click();
          a2.remove();
        }
      }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function () {
      alert(gone
        ? "That sheet is no longer shared — the plans list has been updated."
        : "Couldn't open that file — check your connection and try again.");
    }).finally(function () {
      btn.textContent = original;
      btn.disabled = false;
    });
  }

  // ------------------------------------------------------------- messages

  function loadMessages() {
    rpc("sub_list_messages", { p_token: token }).then(function (msgs) {
      msgs = Array.isArray(msgs) ? msgs : [];
      var thread = $("msg-thread");
      var nearBottom = thread.scrollHeight - thread.scrollTop -
        thread.clientHeight < 80;
      thread.innerHTML = "";
      $("msg-empty").hidden = msgs.length > 0;
      msgs.forEach(function (m) {
        var div = document.createElement("div");
        div.className = "bubble " + (m.sender_type === "gc" ? "gc" : "sub");
        div.innerHTML =
          '<span class="who">' + esc(m.sender_name ||
            (m.sender_type === "gc" ? "Contractor" : "You")) + "</span>" +
          esc(m.body) +
          '<span class="when">' + esc(fmtDateTime(m.created_at)) + "</span>";
        thread.appendChild(div);
      });
      if (nearBottom || !thread.dataset.scrolled) {
        thread.scrollTop = thread.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        thread.dataset.scrolled = "1";
      }
    }).catch(function () { /* quiet — next refresh retries */ });
  }

  function ensureName() {
    var name = storeGet("name");
    if (name) return Promise.resolve(name);
    return new Promise(function (resolve) {
      $("name-modal").hidden = false;
      $("name-input").focus();
      $("name-form").onsubmit = function (ev) {
        ev.preventDefault();
        var v = $("name-input").value.trim() ||
          (project && project.sub_company_name) || "";
        storeSet("name", v);
        $("name-modal").hidden = true;
        resolve(v);
      };
    });
  }

  $("msg-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = $("msg-input").value.trim();
    if (!body) return;
    ensureName().then(function (name) {
      return rpc("sub_post_message",
        { p_token: token, p_sender_name: name, p_body: body });
    }).then(function () {
      $("msg-input").value = "";
      loadMessages();
    }).catch(function () {
      alert("Couldn't send — check your connection and try again.");
    });
  });

  // ------------------------------------------------------------ submit bid

  // v1.16.3 — the invited trades become checkboxes, each with its own
  // amount box. These feed p_divisions/p_amounts on sub_submit_bid, which
  // the contractor's app turns into pre-answered File Bid sort questions.
  // No invited trades on the token => the plain single amount field stays.
  // The bid date defaults to today in the SUB's own time zone (toISOString
  // would be UTC, which is tomorrow for a US evening).
  function todayIso() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  // v1.22.5 round 5 — the amount box takes a NUMBER and nothing else.
  // Aaron: *"only accept digits, no commas dollar sign or anything stright
  // numbers 125000"*, with the commas added as you type and ".00" added when
  // you leave the box unless you typed the "." yourself. The contractor's app
  // names the filed bid from this number, and a free-text box let "25k" file
  // as $25.00 and "25,000 - 30,000" as $2,500,030,000.00.
  var MONEY_MAX_DIGITS = 12;

  function moneyShape(raw) {
    // Digits and ONE "." survive; at most 2 digits after it.
    var s = String(raw || "").replace(/[^\d.]/g, "");
    var dot = s.indexOf(".");
    var whole = dot < 0 ? s : s.slice(0, dot);
    var cents = dot < 0 ? null : s.slice(dot + 1).replace(/\./g, "").slice(0, 2);
    whole = whole.replace(/^0+(?=\d)/, "").slice(0, MONEY_MAX_DIGITS);
    var grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (cents === null) return grouped;
    return (grouped || "0") + "." + cents;
  }

  function attachMoney(input) {
    if (!input) return;
    input.setAttribute("inputmode", "decimal");
    // Anything typed or pasted that is not a plain number is refused whole,
    // never stripped down to its digits: "25,000 - 30,000" must not become
    // 2,500,030,000 and "25k" must not become 25. A leading "$" and spaces
    // are the only things let go, so a pasted "$ 125,000" still works.
    var plain = function (t) {
      return /^[\d.,]*$/.test(String(t || "").trim().replace(/^\$\s*/, ""));
    };
    input.addEventListener("beforeinput", function (ev) {
      if (ev.inputType === "insertText" && ev.data != null && !plain(ev.data)) {
        ev.preventDefault();
      }
    });
    input.addEventListener("paste", function (ev) {
      var t = (ev.clipboardData || window.clipboardData);
      t = t ? t.getData("text") : "";
      if (!plain(t)) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      var clean = String(t).trim().replace(/^\$\s*/, "");
      var a = input.selectionStart, b = input.selectionEnd;
      if (a == null) { a = b = input.value.length; }
      input.value = input.value.slice(0, a) + clean + input.value.slice(b);
      try { input.setSelectionRange(a + clean.length, a + clean.length); } catch (e) { /* ignore */ }
      input.dispatchEvent(new Event("input"));
    });
    input.addEventListener("input", function () {
      var before = input.value;
      var caret = input.selectionStart == null ? before.length : input.selectionStart;
      // Where the caret sits, counted in characters that survive (digits and
      // the "."), so a comma appearing ahead of it does not shove it along.
      var keep = before.slice(0, caret).replace(/[^\d.]/g, "").length;
      var after = moneyShape(before);
      if (after === before) return;
      input.value = after;
      var pos = 0, seen = 0;
      while (pos < after.length && seen < keep) {
        if (/[\d.]/.test(after[pos])) seen++;
        pos++;
      }
      try { input.setSelectionRange(pos, pos); } catch (e) { /* not focused */ }
    });
    input.addEventListener("blur", function () {
      var v = moneyShape(input.value);
      if (!/\d/.test(v)) { input.value = ""; return; }
      if (v.indexOf(".") < 0) v += ".00";
      else if (/\.$/.test(v)) v += "00";
      input.value = v;
    });
  }

  // What the box holds once the ".00" rule has run — Submit can be clicked
  // straight from the box, before its blur has fired.
  function finishMoney(input) {
    if (!input) return "";
    var v = moneyShape(input.value);
    if (!/\d/.test(v)) return "";
    if (v.indexOf(".") < 0) v += ".00";
    else if (/\.$/.test(v)) v += "00";
    return v;
  }

  function isMoney(t) {
    return /^\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(String(t || "").trim()) &&
      /[1-9]/.test(String(t));
  }

  // The bid date must be a real one within ten years either side of today —
  // "0026" or "2099" is a slip of the keyboard, and it becomes the date in
  // the filed bid's name.
  var DATE_SPAN_YEARS = 10;
  function dateBounds() {
    var now = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var mmdd = "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    return { min: (now.getFullYear() - DATE_SPAN_YEARS) + mmdd,
             max: (now.getFullYear() + DATE_SPAN_YEARS) + mmdd };
  }

  function renderBidDivisions() {
    var codes = ((project && project.divisions) || []).slice().sort(byCode);
    if (!codes.length) return;
    $("bid-amount-single").hidden = true;
    $("bid-divisions-field").hidden = false;
    var list = $("bid-divisions");
    list.innerHTML = "";
    codes.forEach(function (code) {
      var row = document.createElement("div");
      row.className = "division-row";
      var safe = esc(String(code));
      row.innerHTML =
        '<label class="division-check">' +
        '<input type="checkbox" checked data-code="' + safe + '"> ' +
        esc(divisionChip(code)) + "</label>" +
        '<input type="text" inputmode="decimal" class="division-amount" ' +
        'placeholder="e.g. 125000" maxlength="20" data-code="' +
        safe + '">';
      var box = row.querySelector("input[type=checkbox]");
      var amount = row.querySelector(".division-amount");
      attachMoney(amount);
      box.addEventListener("change", function () {
        amount.disabled = !box.checked;
        row.classList.toggle("off", !box.checked);
      });
      list.appendChild(row);
    });
  }

  function collectBidAnswers() {
    // -> {divisions: [...], amounts: {...}, amount_text: "..."} for the RPC.
    var out = { divisions: [], amounts: {}, amount_text: "",
                bid_date: ($("bid-date").value || "").trim() };
    var rows = document.querySelectorAll("#bid-divisions .division-row");
    if (!rows.length) {
      out.amount_text = finishMoney($("bid-amount"));
      return out;
    }
    rows.forEach(function (row) {
      var box = row.querySelector("input[type=checkbox]");
      if (!box || !box.checked) return;
      var code = box.getAttribute("data-code");
      out.divisions.push(code);
      var amount = finishMoney(row.querySelector(".division-amount"));
      if (amount) out.amounts[code] = amount;
    });
    // amount_text mirrors the single amount when exactly one trade is
    // checked, so anything reading the old column still sees the number.
    if (out.divisions.length === 1) {
      out.amount_text = out.amounts[out.divisions[0]] || "";
    }
    return out;
  }

  // v1.22.5 — the contractor's app now files a portal bid straight into the
  // project under the division(s) picked here, named with the amount typed
  // here. So both are required: a trade, and a price for each trade ticked.
  // Returns the message to show, or "" when the answers are complete.
  function bidAnswersProblem(answers) {
    var rows = document.querySelectorAll("#bid-divisions .division-row");
    // v1.22.5 round 4 — the bid date is File Bid's fourth question.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(answers.bid_date || "")) {
      return "Enter the date on your bid.";
    }
    var span = dateBounds();
    if (answers.bid_date < span.min || answers.bid_date > span.max) {
      return "Check the date on your bid — it should be within " +
        DATE_SPAN_YEARS + " years of today.";
    }
    if (!rows.length) {
      return isMoney(answers.amount_text) ? "" :
        "Enter your bid amount as a number — e.g. 125000.";
    }
    if (!answers.divisions.length) {
      return "Tick at least one trade this bid covers.";
    }
    for (var i = 0; i < answers.divisions.length; i++) {
      if (!isMoney(answers.amounts[answers.divisions[i]])) {
        return "Enter an amount for " +
          divisionChip(answers.divisions[i]) + " as a number — e.g. 125000.";
      }
    }
    return "";
  }

  function setFile(file) {
    $("file-error").hidden = true;
    // The name decides: the server refuses any bid whose name does not end
    // in .pdf, so accepting one here only moved the refusal to Send.
    var isPdf = file && /\.pdf$/i.test(file.name || "");
    if (!isPdf) {
      $("file-error").textContent = "Bids must be a PDF file.";
      $("file-error").hidden = false;
      return;
    }
    if (file.size > MAX_BID_BYTES) {
      $("file-error").textContent =
        "That file is " + fmtSize(file.size) + " — the limit is 25 MB. " +
        "Try flattening or re-exporting the PDF at a smaller size.";
      $("file-error").hidden = false;
      return;
    }
    chosenFile = file;
    $("file-chosen").textContent =
      file.name + " (" + (fmtSize(file.size) || "small") + ")";
    $("file-chosen").hidden = false;
    $("submit-bid").disabled = false;
  }

  $("choose-file").addEventListener("click", function () {
    $("file-input").click();
  });
  $("file-input").addEventListener("change", function () {
    if (this.files && this.files[0]) setFile(this.files[0]);
  });

  var dz = $("dropzone");
  ["dragenter", "dragover"].forEach(function (evName) {
    dz.addEventListener(evName, function (ev) {
      ev.preventDefault();
      dz.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (evName) {
    dz.addEventListener(evName, function (ev) {
      ev.preventDefault();
      dz.classList.remove("dragover");
    });
  });
  dz.addEventListener("drop", function (ev) {
    var f = ev.dataTransfer && ev.dataTransfer.files &&
      ev.dataTransfer.files[0];
    if (f) setFile(f);
  });

  function showBidView(id) {
    ["bid-form-view", "bid-sending-view", "bid-success-view", "declined-view"]
      .forEach(function (v) { $(v).hidden = (v !== id); });
  }

  $("submit-bid").addEventListener("click", function () {
    if (!chosenFile) return;
    $("submit-error").hidden = true;
    var problem = bidAnswersProblem(collectBidAnswers());
    if (problem) {
      $("submit-error").textContent = problem;
      $("submit-error").hidden = false;
      return;
    }
    showBidView("bid-sending-view");
    $("sending-status").textContent = "Sending your bid…";
    var storage = null;
    rpc("sub_request_bid_upload",
      { p_token: token, p_filename: chosenFile.name }
    ).then(function (grant) {
      if (!grant || !grant.path) throw new Error("no upload window");
      storage = grant;
      $("sending-status").textContent = "Uploading " + chosenFile.name + "…";
      return uploadFile(grant.bucket || "bids", grant.path, chosenFile);
    }).then(function () {
      $("sending-status").textContent = "Recording your bid…";
      var answers = collectBidAnswers();
      return rpc("sub_submit_bid", {
        p_token: token,
        p_storage_path: storage.path,
        p_filename: chosenFile.name,
        p_amount_text: answers.amount_text,
        p_note: $("bid-note").value.trim(),
        p_divisions: answers.divisions,
        p_amounts: answers.amounts,
        p_bid_date: answers.bid_date
      });
    }).then(function () {
      showBidView("bid-success-view");
    }).catch(function (e) {
      showBidView("bid-form-view");
      var said = String((e && e.message) || "");
      $("submit-error").textContent = e.unauthorized
        ? "This link is no longer active — reply to the invitation email instead."
        : /pdf/i.test(said)
          ? "Bids must be a PDF file — choose the PDF of your bid."
          : /HTTP 413|too large|payload/i.test(said)
            ? "That file is too large to send — try re-exporting the PDF " +
              "at a smaller size."
            : "Sending failed — check your connection and try again. " +
              "Your file is still selected.";
      $("submit-error").hidden = false;
    });
  });

  $("submit-another").addEventListener("click", function () {
    chosenFile = null;
    $("file-input").value = "";
    $("file-chosen").hidden = true;
    $("submit-bid").disabled = true;
    showBidView("bid-form-view");
  });

  // decline flow
  $("decline-link").addEventListener("click", function (ev) {
    ev.preventDefault();
    $("decline-form").hidden = false;
    $("decline-reason").focus();
  });
  $("decline-cancel").addEventListener("click", function () {
    $("decline-form").hidden = true;
  });
  $("decline-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    rpc("sub_decline", {
      p_token: token,
      p_reason: $("decline-reason").value.trim()
    }).then(function () {
      showBidView("declined-view");
    }).catch(function () {
      alert("Couldn't send that — check your connection and try again.");
    });
  });
  $("declined-bid-anyway").addEventListener("click", function () {
    $("declined-note").hidden = false;
    showBidView("bid-form-view");
  });

  attachMoney($("bid-amount"));
  // After DATE_SPAN_YEARS is assigned (a `var` is hoisted but empty above it).
  if ($("bid-date")) {
    if (!$("bid-date").value) $("bid-date").value = todayIso();
    var bounds = dateBounds();
    $("bid-date").min = bounds.min;
    $("bid-date").max = bounds.max;
  }

  boot();
})();
