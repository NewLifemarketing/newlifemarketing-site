/* admin.js — NewLife admin console.
   Loads only on /portal/admin/. Everything here runs as the signed-in admin
   under normal RLS: there is no service-role key in the browser and no session
   impersonation. An admin can read every client because the policies say so,
   and can write because the admin-console migration granted the privileges
   those policies were always waiting on. A non-admin who loads this page sees
   the refusal below and, even if they bypassed it, would read nothing. */
(function () {
  "use strict";

  var host = document.getElementById("pl-client-list");
  if (!host) return;                       /* not the admin page */

  var PLATFORMS = [
    { key: "meta",       label: "Meta Ads" },
    { key: "google_ads", label: "Google Ads" },
    { key: "gbp",        label: "Google Business Profile" },
    { key: "seo",        label: "Search Engine Optimization" },
    { key: "organic",    label: "Social Media Analytics" },
    { key: "website",    label: "Website Analytics" }
  ];
  var PLATFORM_LABEL = {};
  PLATFORMS.forEach(function (p) { PLATFORM_LABEL[p.key] = p.label; });

  var ctx = null, clients = [], editing = null;

  /* One full reporting cycle. Reports are dropped every two weeks. */
  var STALE_DAYS = 14;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function fmtDate(d) {
    if (!d) return "—";
    var t = new Date(d + (String(d).length === 10 ? "T00:00:00" : ""));
    return isNaN(t) ? "—" : t.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  /* Monthly value is mirrored from HQ purely to order this list. It is staff-
     only - the RPC refuses anyone who is not an admin - and never reaches a
     client's dashboard. */
  function money(v) {
    var n = Number(v);
    if (!isFinite(n) || v === null || v === undefined) return "";
    return "$" + Math.round(n).toLocaleString("en-CA") + "/mo";
  }

  function daysSince(d) {
    if (!d) return null;
    var t = new Date(d);
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t.getTime()) / 86400000);
  }

  function notAdmin(msg) {
    host.innerHTML = '<p class="pl-muted" style="margin:0">' + esc(msg) + "</p>";
    qsa(".pl-view").forEach(function (v) {
      if (v.getAttribute("data-av") !== "clients") v.innerHTML = "";
    });
  }

  /* ---------------- view switching ---------------- */
  var TITLES = { clients: "Clients", rollup: "Roll-up", weekly: "Weekly Reports", health: "Data health" };
  qsa(".pl-nav-item[data-av]").forEach(function (b) {
    b.addEventListener("click", function () {
      var v = b.getAttribute("data-av");
      qsa(".pl-nav-item[data-av]").forEach(function (x) { x.classList.toggle("active", x === b); });
      qsa(".pl-view[data-av]").forEach(function (s) { s.classList.toggle("active", s.getAttribute("data-av") === v); });
      document.getElementById("pl-admin-title").textContent = TITLES[v] || "Console";
      document.querySelector(".pl-app").classList.remove("nav-open");
      window.scrollTo(0, 0);
    });
  });
  qsa("[data-open-nav]").forEach(function (b) {
    b.addEventListener("click", function () { document.querySelector(".pl-app").classList.add("nav-open"); });
  });
  qsa("[data-close-nav]").forEach(function (b) {
    b.addEventListener("click", function () { document.querySelector(".pl-app").classList.remove("nav-open"); });
  });

  /* ---------------- render: client list ---------------- */
  function renderClients() {
    document.getElementById("pl-client-count").textContent =
      clients.length + (clients.length === 1 ? " client" : " clients");
    document.getElementById("pl-admin-sub").textContent =
      clients.length + " clients · " +
      clients.reduce(function (a, c) { return a + (c.rows_total || 0); }, 0) + " report rows · highest value first";

    if (!clients.length) {
      host.innerHTML = '<p class="pl-muted" style="margin:0">No clients yet.</p>';
      return;
    }
    host.innerHTML = clients.map(function (c) {
      var chans = (c.sections || []).map(function (s) {
        var has = (c.platforms || []).indexOf(s) !== -1;
        return '<span class="pl-tag' + (has ? " on" : "") + '" title="' +
               (has ? "Has data" : "Enabled but no data loaded") + '">' +
               esc(PLATFORM_LABEL[s] || s) + "</span>";
      }).join("");
      var stale = daysSince(c.last_refresh);
      /* Reporting is two-weekly, so 14 days is one full cycle. Anything past
         that means a cycle was missed. (Was 21 — correct when reports were
         monthly.) */
      var freshness = c.last_refresh
        ? (stale > STALE_DAYS
            ? '<span class="pl-stale">' + stale + " days since last load</span>"
            : '<span class="pl-fresh">Updated ' + fmtDate(c.last_refresh) + '</span>')
        : '<span class="pl-stale">No data loaded</span>';
      return '' +
        '<div class="pl-crow">' +
          '<div class="pl-crow-main">' +
            '<div class="pl-crow-name">' + esc(c.business_name || c.name) +
              (c.monthly_value ? ' <span class="pl-mrr">' + esc(money(c.monthly_value)) + "</span>" : "") +
            "</div>" +
            '<div class="pl-crow-meta">' +
              (c.periods || 0) + (c.periods === 1 ? " period" : " periods") + " · " +
              (c.rows_total || 0) + " rows · " +
              (c.users || 0) + (c.users === 1 ? " login" : " logins") + " · " +
              "latest " + fmtDate(c.latest_start) + " – " + fmtDate(c.latest_end) +
            "</div>" +
            '<div class="pl-crow-tags">' + (chans || '<span class="pl-tag">No channels enabled</span>') + "</div>" +
          "</div>" +
          '<div class="pl-crow-side">' + freshness +
            '<div class="pl-crow-btns">' +
              '<a class="pl-btn sm" href="/portal/dashboard/?client=' + encodeURIComponent(c.client_id) + '">View as client →</a>' +
              '<button class="pl-btn ghost sm" type="button" data-edit="' + esc(c.client_id) + '">Edit</button>' +
            "</div>" +
          "</div>" +
        "</div>";
    }).join("");

    qsa("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function () { openEdit(b.getAttribute("data-edit")); });
    });
  }

  /* ---------------- render: roll-up ---------------- */
  function renderRollup() {
    var withData = clients.filter(function (c) { return c.rows_total > 0; });
    var kpis = [
      { label: "Clients", value: String(clients.length) },
      { label: "Live with data", value: String(withData.length) },
      { label: "Report rows", value: String(clients.reduce(function (a, c) { return a + (c.rows_total || 0); }, 0)) },
      { label: "Client logins", value: String(clients.reduce(function (a, c) { return a + (c.users || 0); }, 0)) }
    ];
    document.getElementById("pl-rollup-kpis").innerHTML = kpis.map(function (k) {
      return '<div class="pl-kpi"><div class="k-label">' + esc(k.label) + '</div>' +
             '<div class="k-value">' + esc(k.value) + "</div></div>";
    }).join("");

    var rows = clients.map(function (c) {
      return '<tr><td>' + esc(c.business_name || c.name) + "</td>" +
        "<td>" + fmtDate(c.latest_start) + " – " + fmtDate(c.latest_end) + "</td>" +
        '<td class="num">' + (c.periods || 0) + "</td>" +
        '<td class="num">' + (c.rows_total || 0) + "</td>" +
        "<td>" + ((c.platforms || []).map(function (p) { return PLATFORM_LABEL[p] || p; }).join(", ") || "—") + "</td>" +
        '<td class="num hot">' + fmtDate(c.last_refresh) + "</td></tr>";
    }).join("");
    document.getElementById("pl-rollup-table").innerHTML =
      '<div class="pl-table-scroll"><table class="pl-table"><thead><tr>' +
      "<th>Client</th><th>Latest period</th><th class='num'>Periods</th>" +
      "<th class='num'>Rows</th><th>Channels with data</th><th class='num'>Last load</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";
  }

  /* ---------------- render: data health ---------------- */
  function renderHealth() {
    var issues = [];
    clients.forEach(function (c) {
      var nm = c.business_name || c.name;
      if (!c.users) issues.push([nm, "No login exists yet — this client cannot sign in."]);
      if (!c.rows_total) issues.push([nm, "No report data loaded — they would see empty channel pages."]);
      if (!(c.sections || []).length) issues.push([nm, "No channels enabled — their sidebar would be empty."]);
      (c.sections || []).forEach(function (s) {
        if ((c.platforms || []).indexOf(s) === -1 && c.rows_total)
          issues.push([nm, (PLATFORM_LABEL[s] || s) + " is switched on but has no data loaded."]);
      });
      (c.platforms || []).forEach(function (p) {
        if ((c.sections || []).indexOf(p) === -1)
          issues.push([nm, (PLATFORM_LABEL[p] || p) + " has data loaded but is hidden from the client."]);
      });
      var d = daysSince(c.last_refresh);
      if (d !== null && d > STALE_DAYS) issues.push([nm, "Last load was " + d + " days ago — reports are due every two weeks."]);
    });
    var el = document.getElementById("pl-health");
    if (!issues.length) {
      el.innerHTML = '<p class="pl-muted" style="margin:0">Nothing to flag. Every client has a login, enabled channels and current data.</p>';
      return;
    }
    el.innerHTML = '<div class="pl-table-scroll"><table class="pl-table"><thead><tr>' +
      "<th>Client</th><th>What a client would see</th></tr></thead><tbody>" +
      issues.map(function (i) {
        return "<tr><td>" + esc(i[0]) + '</td><td class="pl-warn">' + esc(i[1]) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  /* ---------------- edit client ---------------- */
  var modal = document.getElementById("pl-edit");
  var form = document.getElementById("pl-edit-form");
  var msg = document.getElementById("pl-edit-msg");

  function closeEdit() { modal.hidden = true; editing = null; msg.style.display = "none"; }
  qsa("[data-edit-close]").forEach(function (b) { b.addEventListener("click", closeEdit); });
  modal.addEventListener("click", function (e) { if (e.target === modal) closeEdit(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) closeEdit(); });

  function openEdit(id) {
    var c = clients.filter(function (x) { return x.client_id === id; })[0];
    if (!c) return;
    editing = c;
    document.getElementById("pl-edit-title").textContent = "Edit " + (c.business_name || c.name);
    form.name.value = c.name || "";
    form.business_name.value = c.business_name || "";
    document.getElementById("pl-edit-sections").innerHTML = PLATFORMS.map(function (p) {
      var on = (c.sections || []).indexOf(p.key) !== -1;
      var hasData = (c.platforms || []).indexOf(p.key) !== -1;
      return '<label class="pl-check"><input type="checkbox" value="' + p.key + '"' +
        (on ? " checked" : "") + "> <span>" + esc(p.label) + "</span>" +
        (hasData ? '<span class="pl-tag on">has data</span>' : "") + "</label>";
    }).join("");
    msg.style.display = "none";
    modal.hidden = false;
  }

  form.addEventListener("submit", function () {
    if (!editing || !ctx) return;
    var btn = document.getElementById("pl-edit-save");
    var sections = qsa("#pl-edit-sections input:checked").map(function (i) { return i.value; });
    btn.disabled = true; btn.textContent = "Saving…";
    ctx.sb.from("clients").update({
      name: form.name.value.trim(),
      business_name: form.business_name.value.trim() || null,
      sections: sections
    }).eq("id", editing.client_id).then(function (r) {
      btn.disabled = false; btn.textContent = "Save changes";
      if (r.error) {
        msg.className = "pl-warn";
        msg.textContent = "Could not save: " + r.error.message +
          " — if this says permission denied, the admin-console migration has not been run yet.";
        msg.style.display = "block";
        return;
      }
      closeEdit();
      load();
    });
  });


  /* ================= WEEKLY REPORTS =================
     Keegan publishes Friday's video + PDF here. Each asset is either uploaded
     into the private `client-files` bucket or supplied as a link.

     The size guard matters: the project is on the Supabase free tier, which
     caps a single file at 50 MB and the whole bucket at 1 GB. A 1-2 minute
     screen recording is routinely 50-150 MB, so an upload will often be
     refused by the server with an opaque error. We check first and say plainly
     what to do instead, rather than letting it fail at the end of a long
     upload with nothing useful on screen. */

  var MAX_UPLOAD_BYTES = 50 * 1024 * 1024;   /* free-tier per-file ceiling */

  var wkEls = {};
  ["client","week","title","summary","publish","reset","msg","list","count",
   "video-drop","video-input","video-name","video-url",
   "pdf-drop","pdf-input","pdf-name","pdf-url","progress","storage"].forEach(function (k) {
    wkEls[k] = document.getElementById("pl-wk-" + k);
  });

  var wkFiles = { video: null, pdf: null };

  function humanSize(b) {
    if (!b && b !== 0) return "";
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b >= 1024) return Math.round(b / 1024) + " KB";
    return b + " B";
  }

  function wkMsg(text, kind) {
    if (!wkEls.msg) return;
    wkEls.msg.textContent = text;
    wkEls.msg.className = kind === "bad" ? "pl-warn" : kind === "good" ? "pl-fresh" : "pl-muted";
    wkEls.msg.style.display = text ? "block" : "none";
  }

  /* Friday of the current week, so the field is already right on a Friday. */
  function lastFriday() {
    var d = new Date();
    var delta = (d.getDay() - 5 + 7) % 7;   /* 5 = Friday */
    d.setDate(d.getDate() - delta);
    return d.toISOString().slice(0, 10);
  }

  function attachDrop(dropEl, inputEl, nameEl, kind, accept) {
    if (!dropEl || !inputEl) return;
    function take(file) {
      if (!file) return;
      if (accept && file.type && file.type.indexOf(accept) !== 0) {
        wkMsg("That looks like a " + (file.type || "file") + ". Expected a " + kind + ".", "bad");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        wkFiles[kind] = null;
        nameEl.textContent = "";
        dropEl.classList.remove("has-file");
        wkMsg(file.name + " is " + humanSize(file.size) + ". The storage plan caps a single file at " +
              humanSize(MAX_UPLOAD_BYTES) + ", so this upload would be refused. " +
              "Paste a Loom or Drive link instead, or compress the file.", "bad");
        return;
      }
      wkFiles[kind] = file;
      nameEl.textContent = file.name + "  (" + humanSize(file.size) + ")";
      dropEl.classList.add("has-file");
      wkMsg("");
    }
    dropEl.addEventListener("click", function () { inputEl.click(); });
    dropEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputEl.click(); }
    });
    inputEl.addEventListener("change", function () { take(inputEl.files && inputEl.files[0]); });
    ["dragenter", "dragover"].forEach(function (ev) {
      dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.add("drag"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.remove("drag"); });
    });
    dropEl.addEventListener("drop", function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files) take(e.dataTransfer.files[0]);
    });
  }

  function wkProgress(pct) {
    if (!wkEls.progress) return;
    if (pct === null) { wkEls.progress.hidden = true; wkEls.progress.innerHTML = ""; return; }
    wkEls.progress.hidden = false;
    if (!wkEls.progress.firstChild) wkEls.progress.innerHTML = "<span></span>";
    wkEls.progress.firstChild.style.width = Math.max(2, Math.min(100, pct)) + "%";
  }

  function uploadOne(clientId, week, file, kind) {
    var ext = (file.name.match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase();
    var path = clientId + "/weekly/" + week + "/" + kind + ext;
    return ctx.sb.storage.from("client-files")
      .upload(path, file, { upsert: true, contentType: file.type || undefined })
      .then(function (r) {
        if (r && r.error) throw new Error(r.error.message || "upload failed");
        return path;
      });
  }

  function renderWkList(rows) {
    if (!wkEls.list) return;
    wkEls.count.textContent = rows.length + (rows.length === 1 ? " report" : " reports");
    if (!rows.length) {
      wkEls.list.innerHTML = '<p class="pl-muted" style="margin:0">Nothing published for this client yet.</p>';
      return;
    }
    wkEls.list.innerHTML = rows.map(function (r) {
      var bits = [];
      if (r.video_path || r.video_url) bits.push('<span class="pl-tag on">Video</span>');
      if (r.pdf_path || r.pdf_url) bits.push('<span class="pl-tag on">PDF</span>');
      var titleBit = r.title ? '<span class="when"> · ' + esc(r.title) + "</span>" : "";
      return '<div class="pl-wk-row">' +
        '<span><span class="who">' + esc(fmtDate(r.week_ending)) + "</span>" + titleBit + "</span>" +
        "<span>" + (bits.join(" ") || '<span class="pl-tag">Empty</span>') + "</span>" +
        "</div>";
    }).join("");
  }

  function loadWkList() {
    if (!ctx || !wkEls.client || !wkEls.client.value) return;
    ctx.sb.from("weekly_reports")
      .select("week_ending, title, video_path, video_url, pdf_path, pdf_url")
      .eq("client_id", wkEls.client.value)
      .order("week_ending", { ascending: false })
      .then(function (r) { renderWkList((r && r.data) || []); });
  }

  function wkReset(keepClient) {
    wkFiles = { video: null, pdf: null };
    ["video", "pdf"].forEach(function (k) {
      if (wkEls[k + "-name"]) wkEls[k + "-name"].textContent = "";
      if (wkEls[k + "-drop"]) wkEls[k + "-drop"].classList.remove("has-file");
      if (wkEls[k + "-input"]) wkEls[k + "-input"].value = "";
      if (wkEls[k + "-url"]) wkEls[k + "-url"].value = "";
    });
    if (wkEls.title) wkEls.title.value = "";
    if (wkEls.summary) wkEls.summary.value = "";
    if (!keepClient && wkEls.week) wkEls.week.value = lastFriday();
    wkProgress(null);
    wkMsg("");
  }

  function wkPublish() {
    if (!ctx) return;
    var clientId = wkEls.client && wkEls.client.value;
    var week = wkEls.week && wkEls.week.value;
    if (!clientId) { wkMsg("Choose a client first.", "bad"); return; }
    if (!week) { wkMsg("Set the week-ending date.", "bad"); return; }

    var videoUrl = (wkEls["video-url"].value || "").trim();
    var pdfUrl = (wkEls["pdf-url"].value || "").trim();
    if (!wkFiles.video && !videoUrl && !wkFiles.pdf && !pdfUrl) {
      wkMsg("Add a video or a PDF - either a file or a link - before publishing.", "bad");
      return;
    }

    wkEls.publish.disabled = true;
    wkEls.publish.textContent = "Publishing…";
    wkProgress(5);

    var row = {
      client_id: clientId,
      week_ending: week,
      title: (wkEls.title.value || "").trim() || null,
      summary: (wkEls.summary.value || "").trim() || null,
      video_url: videoUrl || null,
      pdf_url: pdfUrl || null,
      video_path: null,
      pdf_path: null
    };

    var chain = Promise.resolve();
    if (wkFiles.video) {
      chain = chain.then(function () {
        wkProgress(20);
        return uploadOne(clientId, week, wkFiles.video, "video").then(function (p) { row.video_path = p; });
      });
    }
    if (wkFiles.pdf) {
      chain = chain.then(function () {
        wkProgress(65);
        return uploadOne(clientId, week, wkFiles.pdf, "pdf").then(function (p) { row.pdf_path = p; });
      });
    }

    chain.then(function () {
      wkProgress(85);
      /* One row per client per week - publishing again replaces that week. */
      return ctx.sb.from("weekly_reports").upsert(row, { onConflict: "client_id,week_ending" });
    }).then(function (r) {
      if (r && r.error) throw new Error(r.error.message);
      wkProgress(100);
      /* Reset FIRST: wkReset clears the message box, so setting the
         confirmation before it would wipe the only feedback Keegan gets. */
      wkReset(true);
      wkMsg("Published \u2014 " + fmtDate(row.week_ending) + " is live for this client now.", "good");
      setTimeout(function () { wkProgress(null); }, 900);
      loadWkList();
    }).catch(function (err) {
      wkProgress(null);
      var m = (err && err.message) || "Something went wrong.";
      if (/exceeded|too large|413|payload/i.test(m)) {
        m = "The server refused the file as too large. The free storage plan caps a single " +
            "file at " + humanSize(MAX_UPLOAD_BYTES) + " - paste a Loom or Drive link instead.";
      } else if (/permission|denied|row-level/i.test(m)) {
        m = "Permission denied - this account is not an admin, so it cannot publish.";
      }
      wkMsg(m, "bad");
    }).then(function () {
      wkEls.publish.disabled = false;
      wkEls.publish.textContent = "Publish to the client";
    });
  }

  function initWeekly() {
    if (!wkEls.client) return;
    wkEls.client.innerHTML = clients.map(function (c) {
      return '<option value="' + esc(c.client_id) + '">' + esc(c.business_name || c.name) + "</option>";
    }).join("");
    if (wkEls.week && !wkEls.week.value) wkEls.week.value = lastFriday();
    if (wkEls.storage) {
      wkEls.storage.textContent = "Single file limit " + humanSize(MAX_UPLOAD_BYTES) + " · links have no limit";
    }
    loadWkList();
  }

  attachDrop(wkEls["video-drop"], wkEls["video-input"], wkEls["video-name"], "video", "video");
  attachDrop(wkEls["pdf-drop"], wkEls["pdf-input"], wkEls["pdf-name"], "pdf", "application/pdf");
  if (wkEls.client) wkEls.client.addEventListener("change", loadWkList);
  if (wkEls.publish) wkEls.publish.addEventListener("click", wkPublish);
  if (wkEls.reset) wkEls.reset.addEventListener("click", function () { wkReset(true); });

  /* ---------------- load ---------------- */
  function load() {
    ctx.sb.rpc("admin_client_overview").then(function (r) {
      if (r.error) {
        notAdmin("Could not load clients: " + r.error.message +
                 " — if this function is missing, run the admin-console migration.");
        return;
      }
      clients = r.data || [];
      if (!clients.length && !ctx.isAdmin) {
        notAdmin("This console is for NewLife staff. Your account is not an admin.");
        return;
      }
      renderClients(); renderRollup(); renderHealth(); initWeekly();
    });
  }

  document.addEventListener("portal:ready", function (e) {
    ctx = e.detail;
    if (!ctx || !ctx.sb) { notAdmin("Not signed in."); return; }
    if (!ctx.isAdmin) {
      notAdmin("This console is for NewLife staff. Your account is not an admin, so there is nothing to show here.");
      document.getElementById("pl-admin-sub").textContent = "";
      return;
    }
    load();
  });
})();
