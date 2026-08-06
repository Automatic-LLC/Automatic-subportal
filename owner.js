/* Automatic Owner Console (v1.21) — all page behavior.
 *
 * The owner secret is typed into the page (never in the URL — URLs land in
 * history and screenshots) and kept in sessionStorage, or localStorage when
 * "remember on this device" is checked. Every call goes to the
 * owner-credential-checked owner_* RPCs in Cloud/schema.sql:
 *   POST {url}/rest/v1/rpc/<fn>   JSON in / JSON out
 * No library, no build step — plain fetch, mirroring app.js.
 */
(function () {
  "use strict";

  var CLOUD = window.FND_CLOUD || {};
  var RPC_TIMEOUT_MS = 10000;
  var SECRET_KEY = "fnd:owner:secret";

  var secret = "";
  var companies = [];        // owner_list_companies payload
  var current = null;        // company object open in the detail pane

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

  function fmtDateTime(iso) {
    var d = parseTs(iso);
    if (!d) return "";
    return d.toLocaleDateString(undefined,
      { month: "short", day: "numeric", year: "numeric" }) + ", " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function daysAgo(iso) {
    var d = parseTs(iso);
    if (!d) return null;
    return (Date.now() - d.getTime()) / 86400000;
  }

  function fmtSeen(iso) {
    var days = daysAgo(iso);
    if (days == null) return "never";
    if (days < 1.5) return "today/yesterday";
    return Math.round(days) + " days ago";
  }

  function plural(n, word) {
    n = Number(n) || 0;
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0 MB";
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  // ----------------------------------------------------------------- views

  function show(view) {
    ["view-login", "view-loading", "view-app"].forEach(function (id) {
      $(id).hidden = (id !== view);
    });
  }

  function showPane(pane) {
    $("pane-list").hidden = (pane !== "list");
    $("pane-detail").hidden = (pane !== "detail");
  }

  function signOut() {
    clearSecret();
    secret = "";
    companies = [];
    current = null;
    $("login-secret").value = "";
    $("login-error").hidden = true;
    show("view-login");
    $("login-secret").focus();
  }

  // ------------------------------------------------------------ list pane

  function renderStats() {
    var total = companies.length;
    var paid = companies.filter(function (c) { return c.paid; }).length;
    var active = companies.filter(function (c) {
      var d = daysAgo(c.last_seen_at);
      return d != null && d <= 7;
    }).length;
    var chips = [total + (total === 1 ? " company" : " companies"),
                 paid + " paid", active + " active this week"];
    $("stats").innerHTML = chips.map(function (t) {
      return '<span class="chip">' + esc(t) + "</span>";
    }).join("");
  }

  function renderList() {
    var q = $("search").value.trim().toLowerCase();
    var list = $("company-list");
    list.innerHTML = "";
    var shown = companies.filter(function (c) {
      if (!q) return true;
      return (c.name || "").toLowerCase().indexOf(q) >= 0 ||
             (c.fnd_company_id || "").toLowerCase().indexOf(q) >= 0 ||
             (c.owner_note || "").toLowerCase().indexOf(q) >= 0;
    });
    $("list-empty").hidden = companies.length > 0;
    shown.forEach(function (c) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "company-row";
      var days = daysAgo(c.last_seen_at);
      var badge = c.paid
        ? '<span class="badge paid">Paid</span>'
        : '<span class="badge free">Free / locked</span>';
      var meta = [
        esc(c.fnd_company_id),
        "last seen " + esc(fmtSeen(c.last_seen_at)),
        esc(plural(c.project_count, "project")) + " · " +
          esc(plural(c.invite_count, "invite")) + " · " +
          esc(plural(c.bid_count, "bid"))
      ].join(" · ");
      row.innerHTML =
        '<div class="company-info">' +
        '<p class="company-name">' + esc(c.name || "(unnamed)") + "</p>" +
        '<p class="company-meta">' + meta + "</p>" +
        (c.owner_note
          ? '<p class="company-note">📝 ' + esc(c.owner_note) + "</p>" : "") +
        "</div>" +
        (c.app_version
          ? '<span class="ver-chip">v' + esc(c.app_version) + "</span>" : "") +
        (days != null && days > 30
          ? '<span class="badge stale">quiet</span>' : "") +
        badge;
      row.addEventListener("click", function () { openDetail(c); });
      list.appendChild(row);
    });
  }

  function refreshList(showSpinner) {
    if (showSpinner) show("view-loading");
    return ownerRpc("owner_list_companies").then(function (data) {
      companies = Array.isArray(data) ? data : [];
      renderStats();
      renderList();
      show("view-app");
    }).catch(function (e) {
      if (e.unauthorized) {
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

  // ----------------------------------------------------------- detail pane

  function openDetail(c) {
    current = c;
    renderCompanyCard(c);
    $("d-projects").innerHTML = "";
    $("d-activity").innerHTML = "";
    $("d-projects-empty").hidden = true;
    $("d-activity-empty").hidden = true;
    showPane("detail");
    window.scrollTo(0, 0);

    ownerRpc("owner_company_detail", { p_company_id: c.id })
      .then(function (data) {
        if (data && data.company) {
          current = data.company;
          // keep the row's counts fresh in the cached list too
          companies = companies.map(function (row) {
            return row.id === current.id
              ? Object.assign({}, row, data.company) : row;
          });
          renderCompanyCard(current);
        }
        renderProjects((data && data.projects) || []);
      }).catch(handleDetailError);

    ownerRpc("owner_company_activity", { p_company_id: c.id, p_limit: 200 })
      .then(function (events) {
        renderActivity(Array.isArray(events) ? events : []);
      }).catch(handleDetailError);

    $("d-diag").innerHTML = "";
    $("d-diag-empty").hidden = true;
    ownerRpc("owner_company_diagnostics", { p_company_id: c.id })
      .then(function (data) {
        renderDiagnostics(data || {});
      }).catch(handleDetailError);
  }

  function handleDetailError(e) {
    if (e.unauthorized) { signOut(); return; }
    if (e.rpcMessage === "unknown company") {
      // deleted from another tab/device — fall back to the list
      backToList(true);
      return;
    }
    alert("Couldn't load that — check your connection and try again.");
  }

  function renderCompanyCard(c) {
    $("d-name").textContent = c.name || "(unnamed)";
    $("d-fnd").textContent = c.fnd_company_id || "";
    $("d-created").textContent = fmtDate(c.created_at);
    $("d-seen").textContent = c.last_seen_at
      ? (fmtDate(c.last_seen_at) + " (" + fmtSeen(c.last_seen_at) + ")")
      : "never";
    var badge = $("d-paid");
    badge.textContent = c.paid ? "Paid" : "Free / locked";
    badge.className = "badge " + (c.paid ? "paid" : "free");
    $("btn-paid").textContent = c.paid
      ? "Switch to free (lock)" : "Switch to paid (unlock)";
    $("d-note").textContent = c.owner_note || "";
    $("d-note").hidden = !c.owner_note;
  }

  function renderProjects(projects) {
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

  function renderActivity(events) {
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

  // ---------------------------------------------------------- diagnostics

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
    return '<div class="err-list">' + errs.slice().reverse().map(function (e) {
      return '<div class="err-item">' + esc(e) + "</div>";
    }).join("") + "</div>";
  }

  function renderDiagnostics(data) {
    var snap = data && data.snapshot;
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
      esc(fmtDateTime(data.updated_at)) +
      (data.app_version ? " · app v" + esc(data.app_version) + sub : "") +
      "</p>");

    var errCount = Array.isArray(snap.recent_errors) ? snap.recent_errors.length : 0;
    parts.push(group("Recent errors", errCount ? String(errCount) : "",
      renderErrors(snap.recent_errors), errCount > 0));
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
        ? '<p class="mono" style="font-size:13px">' +
          esc(snap.building_types.join(", ")) + "</p>"
        : '<p class="empty">—</p>', false));
    parts.push(group("ITB settings", "", kvTable(snap.itb_settings), false));
    parts.push(group("File Document", "", kvTable(snap.file_document), false));
    parts.push(group("Project defaults", "", kvTable(snap.project_defaults), false));
    parts.push(group("Cloud / storage / activity", "",
      kvTable(Object.assign({}, snap.cloud_settings, snap.storage,
                            snap.activity_log)), false));
    box.innerHTML = parts.join("");
  }

  function backToList(reload) {
    current = null;
    showPane("list");
    if (reload) refreshList(false);
    else { renderStats(); renderList(); }
  }

  // -------------------------------------------------------------- actions

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
          return row.id === current.id
            ? Object.assign({}, row, { paid: next }) : row;
        });
        renderCompanyCard(current);
        renderStats();
        renderList();
      }).catch(function (e) {
        if (e.unauthorized) { signOut(); return; }
        alert("Couldn't change the paid flag — try again.");
      }).finally(function () { btn.disabled = false; });
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
          return row.id === current.id
            ? Object.assign({}, row, { owner_note: note }) : row;
        });
        $("note-modal").hidden = true;
        renderCompanyCard(current);
        renderList();
      }).catch(function (e) {
        if (e.unauthorized) { signOut(); return; }
        alert("Couldn't save the note — try again.");
      });
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
      backToList(true);
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
      refreshList(false);
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
    refreshList(true);
  });

  $("sign-out").addEventListener("click", function (ev) {
    ev.preventDefault();
    signOut();
  });
  $("back-link").addEventListener("click", function (ev) {
    ev.preventDefault();
    backToList(false);
  });
  $("search").addEventListener("input", renderList);
  $("refresh").addEventListener("click", function () {
    refreshList(false).then(function () {
      // if the open company vanished server-side, the list is authoritative
      if (current && !companies.some(function (c) { return c.id === current.id; })) {
        backToList(false);
      }
    });
  });

  function boot() {
    if (!CLOUD.url || !CLOUD.anonKey) {
      show("view-login");
      $("login-error").textContent = "config.js is missing the backend address.";
      $("login-error").hidden = false;
      return;
    }
    secret = loadSecret();
    if (secret) {
      refreshList(true);
    } else {
      show("view-login");
      $("login-secret").focus();
    }
  }

  boot();
})();
