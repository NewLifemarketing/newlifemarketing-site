/* NewLife Client Portal — reporting layer.
   Every number on every report page comes from public.report_cache via RLS
   (a client can only ever read their own rows). Nothing is hardcoded.
   Payload contract: portal/REPORT-DATA-FORMAT.md */
(function () {
  "use strict";

  var app = document.getElementById("pl-app");
  var titleEl = document.getElementById("pl-view-title");
  var periodSel = document.getElementById("pl-period");

  /* view key -> { title, platform (db enum), section (clients.sections entry) } */
  var VIEWS = {
    overview: { title: "Overview", platform: null, section: "overview" },
    meta:     { title: "Meta Ads", platform: "meta", section: "meta" },
    google:   { title: "Google Ads", platform: "google_ads", section: "google_ads" },
    gbp:      { title: "Google Business Profile", platform: "gbp", section: "gbp" },
    seo:      { title: "SEO", platform: "seo", section: "seo" },
    organic:  { title: "Organic", platform: "organic", section: "organic" },
    onboarding: { title: "Onboarding", platform: null, section: null }
  };
  /* Overview channel blocks, in display order */
  var CHANNELS = [
    { view: "meta", platform: "meta", label: "Meta Ads" },
    { view: "google", platform: "google_ads", label: "Google Ads" },
    { view: "gbp", platform: "gbp", label: "Google Business Profile" },
    { view: "seo", platform: "seo", label: "SEO" },
    { view: "organic", platform: "organic", label: "Organic Social" }
  ];

  var ctx = null;          /* from auth.js: { sb, clientId, sections } */
  var periods = [];        /* [{ start, end, label }] newest first */
  var current = null;      /* selected period */
  var reports = {};        /* platform -> row for the current period */
  var charts = {};         /* live Chart instances, destroyed on period change */
  var currentView = "overview";

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function fmtDate(iso) {
    if (!iso) return "";
    var p = String(iso).split("-");
    var M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return M[parseInt(p[1], 10) - 1] + " " + parseInt(p[2], 10) + ", " + p[0];
  }
  function fmtRange(a, b) {
    if (!a || !b) return "";
    var pa = String(a).split("-"), pb = String(b).split("-");
    var M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var sameYear = pa[0] === pb[0];
    var left = M[parseInt(pa[1], 10) - 1] + " " + parseInt(pa[2], 10) + (sameYear ? "" : ", " + pa[0]);
    return left + " – " + M[parseInt(pb[1], 10) - 1] + " " + parseInt(pb[2], 10) + ", " + pb[0];
  }
  function fmtUpdated(ts) {
    if (!ts) return "";
    try {
      var d = new Date(ts);
      return d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }) +
             " at " + d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
  function compact(n) {
    n = num(n);
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "K";
    return String(Math.round(n));
  }
  function money(n) { return "$" + compact(n); }
  function arrow(dir) { return dir === "up" ? "▲ " : dir === "down" ? "▼ " : ""; }

  /* ---------------- renderers ---------------- */
  function renderKpis(host, kpis) {
    if (!host) return;
    if (!kpis || !kpis.length) { host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = kpis.map(function (k) {
      var d = k.delta;
      var delta = d && (d.text || d.dir)
        ? '<div class="k-delta ' + (d.dir === "down" ? "down" : d.dir === "up" ? "up" : "") + '">' +
          esc(arrow(d.dir) + (d.text || "")) + '</div>'
        : "";
      return '<div class="pl-kpi"><div class="k-label">' + esc(k.label) + '</div>' +
             '<div class="k-value">' + esc(k.value) + '</div>' + delta + '</div>';
    }).join("");
  }

  var PALETTE = { blue: "#2196F3", blue2: "#4DABF5", green: "#33C481", grey: "#5c5c70" };
  var CYCLE = ["#2196F3", "#4DABF5", "#33C481", "#5c5c70"];
  var GRID = "rgba(42,42,56,0.9)", TICK = "#7E7E8F";

  function baseOpts(extra) {
    return Object.assign({
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#B7B7C4", boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 11 } } },
        y: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 11 } }, beginAtZero: true }
      }
    }, extra || {});
  }
  var DONUT_OPTS = {
    responsive: true, maintainAspectRatio: false, cutout: "62%",
    plugins: { legend: { position: "bottom", labels: { color: "#B7B7C4", boxWidth: 12, font: { size: 11 } } } }
  };

  function renderCharts(host, specs, key) {
    if (!host) return;
    host.innerHTML = "";
    if (!specs || !specs.length) return;
    var two = specs.length >= 2;
    var wrap = document.createElement("div");
    wrap.className = two ? "pl-grid-2" : "";
    specs.slice(0, 2).forEach(function (spec, i) {
      var id = "chart-" + key + "-" + i;
      var panel = document.createElement("div");
      panel.className = "pl-panel";
      panel.innerHTML = '<div class="pl-panel-head"><h3>' + esc(spec.title || "") + '</h3></div>' +
                        '<div class="pl-chart-wrap"><canvas id="' + id + '"></canvas></div>';
      wrap.appendChild(panel);
    });
    host.appendChild(wrap);
    if (typeof Chart === "undefined") return;
    specs.slice(0, 2).forEach(function (spec, i) {
      var id = "chart-" + key + "-" + i;
      var el = document.getElementById(id);
      if (!el) return;
      var type = spec.type === "doughnut" ? "doughnut" : spec.type === "bar" ? "bar" : "line";
      var datasets = (spec.datasets || []).map(function (ds, di) {
        var col = PALETTE[ds.color] || CYCLE[di % CYCLE.length];
        if (type === "doughnut") {
          return { data: ds.data || [], label: ds.label || "",
                   backgroundColor: (ds.data || []).map(function (_, si) { return CYCLE[si % CYCLE.length]; }),
                   borderColor: "#16161F", borderWidth: 2 };
        }
        if (type === "bar") {
          return { data: ds.data || [], label: ds.label || "",
                   backgroundColor: (ds.data || []).map(function (_, si) { return CYCLE[si % CYCLE.length]; }),
                   borderRadius: 6 };
        }
        return { data: ds.data || [], label: ds.label || "", borderColor: col,
                 backgroundColor: ds.fill ? hexToRgba(col, 0.14) : undefined,
                 fill: !!ds.fill, tension: 0.35, borderWidth: 2 };
      });
      var opts = type === "doughnut" ? DONUT_OPTS
        : baseOpts(type === "bar" && datasets.length === 1 ? { plugins: { legend: { display: false } } } : {});
      charts[id] = new Chart(el, { type: type, data: { labels: spec.labels || [], datasets: datasets }, options: opts });
    });
  }
  function hexToRgba(hex, a) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    return "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + a + ")";
  }

  function cell(val, col) {
    if (val && typeof val === "object") {
      var cls = val.dir === "up" ? "up" : val.dir === "down" ? "down" : "";
      return '<span class="pl-delta ' + cls + '">' + esc(arrow(val.dir) + (val.text || "")) + "</span>";
    }
    return esc(val);
  }
  function renderTables(host, tables) {
    if (!host) return;
    host.innerHTML = "";
    if (!tables || !tables.length) return;
    tables.slice(0, 3).forEach(function (t) {
      var cols = t.columns || [];
      var head = cols.map(function (c) {
        return '<th' + (c.align === "num" ? ' class="num"' : "") + ">" + esc(c.label) + "</th>";
      }).join("");
      var body = (t.rows || []).map(function (r) {
        return "<tr>" + cols.map(function (c) {
          var cls = [];
          if (c.align === "num") cls.push("num");
          if (c.hot) cls.push("hot");
          return "<td" + (cls.length ? ' class="' + cls.join(" ") + '"' : "") + ">" + cell(r[c.key], c) + "</td>";
        }).join("") + "</tr>";
      }).join("");
      var panel = document.createElement("div");
      panel.className = "pl-panel";
      panel.innerHTML = '<div class="pl-panel-head"><h3>' + esc(t.title || "") + "</h3></div>" +
        '<div class="pl-table-scroll"><table class="pl-table"><thead><tr>' + head +
        "</tr></thead><tbody>" + body + "</tbody></table></div>";
      host.appendChild(panel);
    });
  }

  function renderMeta(el, row) {
    if (!el) return;
    if (!row) { el.innerHTML = ""; return; }
    var tag = row.is_sample
      ? '<span class="pl-sample-tag">Sample data</span>'
      : '<span class="pl-period-tag">' + esc(fmtRange(row.period_start, row.period_end)) + "</span>";
    var upd = row.refreshed_at ? ' <span class="pl-dim">· Last updated ' + esc(fmtUpdated(row.refreshed_at)) + "</span>" : "";
    el.innerHTML = '<p class="pl-muted" style="margin:0 0 1.25rem">Reporting period: <strong>' +
      esc(fmtRange(row.period_start, row.period_end)) + "</strong> " + tag + upd + "</p>";
  }

  function emptyState(view, label) {
    var host = document.querySelector('[data-empty="' + view + '"]');
    if (!host) return;
    host.hidden = false;
    host.innerHTML =
      '<div class="pl-panel" style="text-align:center;padding:3rem 1.5rem">' +
      '<div style="font-size:2rem;line-height:1;margin-bottom:0.75rem">📊</div>' +
      "<h3 style=\"margin:0 0 0.4rem\">Your first " + esc(label) + " report is being prepared</h3>" +
      '<p class="pl-muted" style="margin:0;font-size:0.9rem">As soon as we publish a report for this ' +
      "period it will appear here automatically.</p></div>";
  }

  /* ---------------- overview (derived, never stored) ---------------- */
  function renderOverview() {
    var visible = CHANNELS.filter(function (c) { return hasSection(c.section || c.platform); });
    var withData = visible.filter(function (c) { return reports[c.platform]; });
    var metaHost = document.getElementById("pl-meta-overview");
    var kpiHost = document.querySelector('[data-kpis="overview"]');
    var chanHost = document.getElementById("pl-overview-channels");
    var emptyHost = document.querySelector('[data-empty="overview"]');
    if (chanHost) chanHost.innerHTML = "";
    if (emptyHost) { emptyHost.hidden = true; emptyHost.innerHTML = ""; }

    if (!withData.length) {
      renderKpis(kpiHost, null);
      if (metaHost) metaHost.innerHTML = "";
      emptyState("overview", "");
      return;
    }

    /* period + sample badge from any loaded row */
    var any = reports[withData[0].platform];
    var anySample = withData.some(function (c) { return reports[c.platform].is_sample; });
    var latestUpd = withData.map(function (c) { return reports[c.platform].refreshed_at; })
      .filter(Boolean).sort().pop();
    if (metaHost) {
      metaHost.innerHTML = '<p class="pl-muted" style="margin:0 0 1.25rem">Reporting period: <strong>' +
        esc(fmtRange(any.period_start, any.period_end)) + "</strong> " +
        (anySample ? '<span class="pl-sample-tag">Sample data</span>'
                   : '<span class="pl-period-tag">' + esc(fmtRange(any.period_start, any.period_end)) + "</span>") +
        (latestUpd ? ' <span class="pl-dim">· Last updated ' + esc(fmtUpdated(latestUpd)) + "</span>" : "") + "</p>";
    }

    /* headline cards across channels */
    function m(platform, key) {
      var r = reports[platform];
      var s = r && r.payload && r.payload.summary;
      return s && s.metrics ? num(s.metrics[key]) : 0;
    }
    function present(platform) { return !!reports[platform]; }
    var spend = m("meta", "spend") + m("google_ads", "spend");
    var leads = m("meta", "leads") + m("google_ads", "leads");
    var value = m("meta", "conversion_value") + m("google_ads", "conversion_value");
    var cards = [];
    if (present("meta") || present("google_ads")) {
      cards.push({ label: "Total ad spend", value: money(spend) });
      cards.push({ label: "Leads / conversions", value: compact(leads) });
      if (value > 0) cards.push({ label: "Conversion value", value: money(value) });
    }
    if (present("gbp")) cards.push({ label: "GBP calls", value: compact(m("gbp", "calls")) });
    if (present("organic")) cards.push({ label: "Organic engagements", value: compact(m("organic", "engagements")) });
    if (present("seo")) cards.push({ label: "Keywords in top 10", value: compact(m("seo", "keywords_top10")) });
    renderKpis(kpiHost, cards);

    /* compact per-channel blocks */
    if (chanHost) {
      chanHost.innerHTML = visible.map(function (c) {
        var r = reports[c.platform];
        if (!r) {
          return '<div class="pl-panel"><div class="pl-panel-head"><h3>' + esc(c.label) + "</h3></div>" +
            '<p class="pl-muted" style="margin:0;font-size:0.9rem">Report being prepared for this period.</p></div>';
        }
        var s = (r.payload && r.payload.summary) || {};
        var mini = (s.cards || []).slice(0, 4).map(function (k) {
          return '<div class="pl-mini"><div class="m-label">' + esc(k.label) + "</div>" +
                 '<div class="m-value">' + esc(k.value) + "</div></div>";
        }).join("");
        return '<div class="pl-panel"><div class="pl-panel-head"><h3>' + esc(c.label) + "</h3>" +
          '<button class="pl-btn ghost sm" data-goto="' + c.view + '">View full report →</button></div>' +
          '<div class="pl-minis">' + mini + "</div></div>";
      }).join("");
      qsa("[data-goto]").forEach(function (b) {
        b.addEventListener("click", function () { showView(b.getAttribute("data-goto")); });
      });
    }
  }

  /* ---------------- per-channel page ---------------- */
  function renderChannel(view) {
    var cfg = VIEWS[view];
    if (!cfg || !cfg.platform) return;
    var row = reports[cfg.platform];
    var kpiHost = document.querySelector('[data-kpis="' + view + '"]');
    var chartHost = document.querySelector('[data-charts="' + view + '"]');
    var tableHost = document.querySelector('[data-tables="' + view + '"]');
    var emptyHost = document.querySelector('[data-empty="' + view + '"]');
    if (emptyHost) { emptyHost.hidden = true; emptyHost.innerHTML = ""; }
    renderMeta(document.getElementById("pl-meta-" + view), row);
    if (!row) {
      renderKpis(kpiHost, null);
      if (chartHost) chartHost.innerHTML = "";
      if (tableHost) tableHost.innerHTML = "";
      emptyState(view, cfg.title);
      return;
    }
    var pl = row.payload || {};
    renderKpis(kpiHost, pl.kpis);
    renderCharts(chartHost, pl.charts, view);
    renderTables(tableHost, pl.tables);
  }

  function renderAll() {
    Object.keys(charts).forEach(function (k) { try { charts[k].destroy(); } catch (e) {} });
    charts = {};
    renderOverview();
    ["meta", "google", "gbp", "seo", "organic"].forEach(renderChannel);
  }

  /* ---------------- sections / sidebar ---------------- */
  function hasSection(section) {
    if (!section || section === "overview") return true;
    return ctx && ctx.sections && ctx.sections.indexOf(section) !== -1;
  }
  function applySections() {
    qsa(".pl-nav-item[data-section]").forEach(function (b) {
      var s = b.getAttribute("data-section");
      var ok = hasSection(s);
      b.hidden = !ok;
      if (!ok) b.setAttribute("aria-hidden", "true");
    });
  }

  /* ---------------- navigation ---------------- */
  function showView(view) {
    if (!VIEWS[view]) view = "overview";
    currentView = view;
    qsa(".pl-nav-item[data-view]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === view);
    });
    qsa(".pl-view").forEach(function (v) {
      v.classList.toggle("active", v.getAttribute("data-view") === view);
    });
    if (titleEl) titleEl.textContent = VIEWS[view].title;
    if (periodSel) periodSel.hidden = (view === "onboarding") || !periods.length;
    if (app) app.classList.remove("nav-open");
    window.scrollTo(0, 0);
  }
  qsa(".pl-nav-item[data-view]").forEach(function (b) {
    b.addEventListener("click", function () { showView(b.getAttribute("data-view")); });
  });
  qsa("[data-open-nav]").forEach(function (b) {
    b.addEventListener("click", function () { app.classList.add("nav-open"); });
  });
  qsa("[data-close-nav]").forEach(function (b) {
    b.addEventListener("click", function () { app.classList.remove("nav-open"); });
  });

  /* ---------------- data loading ---------------- */
  function loadPeriods() {
    return ctx.sb.from("report_cache")
      .select("period_start, period_end")
      .order("period_start", { ascending: false })
      .then(function (r) {
        var seen = {}, out = [];
        (r.data || []).forEach(function (row) {
          var k = row.period_start + "|" + row.period_end;
          if (seen[k]) return;
          seen[k] = 1;
          out.push({ start: row.period_start, end: row.period_end, label: fmtRange(row.period_start, row.period_end) });
        });
        periods = out;
        if (periodSel) {
          periodSel.innerHTML = out.map(function (p, i) {
            return '<option value="' + i + '">' + esc(p.label) + "</option>";
          }).join("");
          periodSel.hidden = !out.length || currentView === "onboarding";
        }
        return out;
      });
  }
  function loadPeriod(p) {
    current = p;
    reports = {};
    if (!p) { renderAll(); return Promise.resolve(); }
    return ctx.sb.from("report_cache")
      .select("platform, period_start, period_end, payload, is_sample, refreshed_at")
      .eq("period_start", p.start)
      .eq("period_end", p.end)
      .then(function (r) {
        /* Only keep platforms this client is actually subscribed to, so a
           stored-but-unsubscribed report can never surface in the sidebar,
           a channel page or the Overview totals. */
        (r.data || []).forEach(function (row) {
          if (hasSection(row.platform)) reports[row.platform] = row;
        });
        renderAll();
      });
  }
  if (periodSel) periodSel.addEventListener("change", function () {
    var p = periods[parseInt(periodSel.value, 10)];
    if (p) loadPeriod(p);
  });

  /* ---------------- boot ---------------- */
  document.addEventListener("portal:ready", function (e) {
    ctx = e.detail;
    applySections();
    if (!ctx.clientId) { showView("overview"); renderAll(); return; }
    loadPeriods().then(function (list) {
      showView("overview");
      return loadPeriod(list[0] || null);
    });
  });

  /* ---------------- onboarding extras (unchanged behaviour) ---------------- */
  qsa("[data-sample-dl]").forEach(function (a) {
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      alert("Sample document. Real per-client files attach in a later phase.");
    });
  });
  var drop = document.getElementById("pl-drop");
  var fileInput = document.getElementById("pl-fileinput");
  var uploaded = document.getElementById("pl-uploaded");
  function addFiles(files) {
    Array.prototype.forEach.call(files, function (f) {
      var li = document.createElement("li");
      var kb = f.size ? " · " + Math.max(1, Math.round(f.size / 1024)) + " KB" : "";
      li.innerHTML = '<span class="ok">✓</span> <span>' + esc(f.name) + kb +
        ' <span class="pl-dim">(queued — upload activates in a later phase)</span></span>';
      uploaded.appendChild(li);
    });
  }
  if (drop) {
    drop.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () { addFiles(fileInput.files); });
    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("drag"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("drag"); });
    });
    drop.addEventListener("drop", function (e) { if (e.dataTransfer) addFiles(e.dataTransfer.files); });
  }
})();
