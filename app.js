/* Foundation sub portal (v1.15) — all page behavior.
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
  // **CSI ONLY.** A company on the NAHB set numbers its divisions 1-10 by
  // build order, so looking those up in here would tell a sub bidding
  // "5 Rough Structure" that they are bidding "5 Metals". Nothing in the
  // invite payload says which set the GC uses, so until it does an ambiguous
  // number must fall through to a bare "Div N" — a sub reading the WRONG
  // trade name is worse off than one reading no trade name.
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
  function storeKey(suffix) { return "fnd:" + token.slice(0, 12) + ":" + suffix; }
  function storeGet(suffix) {
    try { return localStorage.getItem(storeKey(suffix)); } catch (e) { return null; }
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
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
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
    document.title = (project.project_name || "Bid Portal") + " — Foundation";
    $("due-date").textContent =
      project.due_date ? ("Bids due " + fmtDate(project.due_date)) : "";
    var chips = $("divisions");
    chips.innerHTML = "";
    (project.divisions || []).forEach(function (code) {
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

  function loadPlans() {
    rpc("sub_list_plans", { p_token: token }).then(function (plans) {
      plans = Array.isArray(plans) ? plans : [];
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
    }).catch(function () {
      $("plans-empty").textContent =
        "Couldn't load the plans list — check your connection and reload.";
      $("plans-empty").hidden = false;
    });
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
    fetchFile(p.bucket || "plans", p.path).then(function (blob) {
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
      alert("Couldn't open that file — check your connection and try again.");
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
  function renderBidDivisions() {
    var codes = (project && project.divisions) || [];
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
        'placeholder="Amount (optional)" maxlength="100" data-code="' +
        safe + '">';
      var box = row.querySelector("input[type=checkbox]");
      var amount = row.querySelector(".division-amount");
      box.addEventListener("change", function () {
        amount.disabled = !box.checked;
        row.classList.toggle("off", !box.checked);
      });
      list.appendChild(row);
    });
  }

  function collectBidAnswers() {
    // -> {divisions: [...], amounts: {...}, amount_text: "..."} for the RPC.
    var out = { divisions: [], amounts: {}, amount_text: "" };
    var rows = document.querySelectorAll("#bid-divisions .division-row");
    if (!rows.length) {
      out.amount_text = $("bid-amount").value.trim();
      return out;
    }
    rows.forEach(function (row) {
      var box = row.querySelector("input[type=checkbox]");
      if (!box || !box.checked) return;
      var code = box.getAttribute("data-code");
      out.divisions.push(code);
      var amount = row.querySelector(".division-amount").value.trim();
      if (amount) out.amounts[code] = amount;
    });
    // amount_text mirrors the single amount when exactly one trade is
    // checked, so anything reading the old column still sees the number.
    if (out.divisions.length === 1) {
      out.amount_text = out.amounts[out.divisions[0]] || "";
    }
    return out;
  }

  function setFile(file) {
    $("file-error").hidden = true;
    var isPdf = file && (/\.pdf$/i.test(file.name) ||
      file.type === "application/pdf");
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
        p_amounts: answers.amounts
      });
    }).then(function () {
      showBidView("bid-success-view");
    }).catch(function (e) {
      showBidView("bid-form-view");
      $("submit-error").textContent = e.unauthorized
        ? "This link is no longer active — reply to the invitation email instead."
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

  boot();
})();
