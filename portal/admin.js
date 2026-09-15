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
    { key: "seo",        label: "SEO" },
    { key: "organic",    label: "Organic" }
  ];
  var PLATFORM_LABEL = {};
  PLATFORMS.forEach(function (p) { PLATFORM_LABEL[p.key] = p.label; });

  var ctx = null, clients = [], editing = null;

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
  var TITLES = { clients: "Clients", rollup: "Roll-up", health: "Data health" };
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
      clients.reduce(function (a, c) { return a + (c.rows_total || 0); }, 0) + " report rows";

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
      var freshness = c.last_refresh
        ? (stale > 21
            ? '<span class="pl-stale">' + stale + " days since last load</span>"
            : '<span class="pl-fresh">Updated ' + fmtDate(c.last_refresh) + '</span>')
        : '<span class="pl-stale">No data loaded</span>';
      return '' +
        '<div class="pl-crow">' +
          '<div class="pl-crow-main">' +
            '<div class="pl-crow-name">' + esc(c.business_name || c.name) + "</div>" +
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
      if (d !== null && d > 21) issues.push([nm, "Last load was " + d + " days ago — reports are due every two weeks."]);
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
      renderClients(); renderRollup(); renderHealth();
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
