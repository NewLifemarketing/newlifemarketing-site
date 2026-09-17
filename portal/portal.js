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
  /* Payloads are written by hand, so delta text often already carries its own
     arrow. Strip a leading one rather than rendering "▲ ▲ 3.1". */
  function deltaText(dir, text) {
    return arrow(dir) + String(text || "").replace(/^\s*[▲▼↑↓▴▾]\s*/, "");
  }

  /* ---------------- renderers ---------------- */
  function renderKpis(host, kpis) {
    if (!host) return;
    if (!kpis || !kpis.length) { host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = kpis.map(function (k) {
      var d = k.delta;
      /* Test the RENDERED text, not just the presence of the fields: a delta of
         { dir: "flat", text: "" } passed the old check and drew an empty chip. */
      var dtext = d ? deltaText(d.dir, d.text).trim() : "";
      var delta = dtext
        ? '<div class="k-delta ' + (d.dir === "down" ? "down" : d.dir === "up" ? "up" : "") + '">' +
          esc(dtext) + '</div>'
        : "";
      return '<div class="pl-kpi"><div class="k-label">' + esc(k.label) + '</div>' +
             '<div class="k-value">' + esc(k.value) + '</div>' + delta + '</div>';
    }).join("");
  }

  /* Per-view render caps. A deep channel report legitimately carries several
     charts and tables; without a ceiling one bad payload could render forever. */
  var MAX_CHARTS = 6;
  var MAX_TABLES = 6;

  /* Chart colours are read from the CSS custom properties so the charts always
     follow the stylesheet's theme instead of carrying their own hard-coded
     palette (which is how they stayed dark-theme after the page went light). */
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }
  var PALETTE = {
    blue:  cssVar("--blue", "#1573D6"),
    blue2: cssVar("--blue-hot", "#0D57A8"),
    green: cssVar("--green", "#147A4D"),
    grey:  cssVar("--dim", "#78829A")
  };
  var CYCLE = [PALETTE.blue, PALETTE.blue2, PALETTE.green, PALETTE.grey];
  var GRID = cssVar("--line", "#DFE4EC");
  var TICK = cssVar("--dim", "#78829A");
  var LEGEND = cssVar("--muted", "#4A5468");
  var SURFACE = cssVar("--surface", "#FFFFFF");

  function baseOpts(extra) {
    return Object.assign({
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: LEGEND, boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 11 } } },
        y: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 11 } }, beginAtZero: true }
      }
    }, extra || {});
  }
  var DONUT_OPTS = {
    responsive: true, maintainAspectRatio: false, cutout: "62%",
    plugins: { legend: { position: "bottom", labels: { color: LEGEND, boxWidth: 12, font: { size: 11 } } } }
  };

  function renderCharts(host, specs, key) {
    if (!host) return;
    host.innerHTML = "";
    if (!specs || !specs.length) return;
    /* Channel pages carry real depth now (campaign mix, queries, rankings,
       reviews), so the old hard cap of two charts was throwing data away.
       A single chart runs full width; anything more pairs into rows of two. */
    specs = specs.slice(0, MAX_CHARTS);
    var wrap = document.createElement("div");
    wrap.className = specs.length > 1 ? "pl-chart-grid" : "";
    specs.forEach(function (spec, i) {
      var id = "chart-" + key + "-" + i;
      var panel = document.createElement("div");
      panel.className = "pl-panel";
      panel.innerHTML = '<div class="pl-panel-head"><h3>' + esc(spec.title || "") + '</h3></div>' +
                        '<div class="pl-chart-wrap"><canvas id="' + id + '"></canvas></div>';
      wrap.appendChild(panel);
    });
    host.appendChild(wrap);
    if (typeof Chart === "undefined") return;
    specs.forEach(function (spec, i) {
      var id = "chart-" + key + "-" + i;
      var el = document.getElementById(id);
      if (!el) return;
      var type = spec.type === "doughnut" ? "doughnut" : spec.type === "bar" ? "bar" : "line";
      var datasets = (spec.datasets || []).map(function (ds, di) {
        var col = PALETTE[ds.color] || CYCLE[di % CYCLE.length];
        if (type === "doughnut") {
          return { data: ds.data || [], label: ds.label || "",
                   backgroundColor: (ds.data || []).map(function (_, si) { return CYCLE[si % CYCLE.length]; }),
                   borderColor: SURFACE, borderWidth: 2 };
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
      /* Reports routinely plot spend (thousands) against conversions (tens) on the
         same chart. On one shared axis the small series is flattened onto the
         baseline and tells the client nothing, so give it its own right-hand
         axis whenever the magnitudes are an order apart. */
      var dualAxis = false;
      if (type !== "doughnut" && datasets.length === 2) {
        var mx = datasets.map(function (d) {
          return (d.data || []).reduce(function (a, b) {
            var n = Number(b); return isFinite(n) && n > a ? n : a;
          }, 0);
        });
        var hi = Math.max(mx[0], mx[1]), lo = Math.min(mx[0], mx[1]);
        if (lo > 0 && hi / lo >= 8) {
          dualAxis = true;
          var smallIdx = mx[0] < mx[1] ? 0 : 1;
          datasets[smallIdx].yAxisID = "y1";
          datasets[1 - smallIdx].yAxisID = "y";
        }
      }
      var extra = {};
      if (type === "bar" && datasets.length === 1) extra.plugins = { legend: { display: false } };
      var opts = type === "doughnut" ? DONUT_OPTS : baseOpts(extra);
      if (dualAxis) {
        opts.scales = Object.assign({}, opts.scales, {
          y1: {
            position: "right", beginAtZero: true,
            grid: { drawOnChartArea: false },
            ticks: { color: TICK, font: { size: 11 } }
          }
        });
      }
      /* Re-selecting campaigns re-renders this host, so an instance may already
         be registered under this id. Chart.js keeps its own registry of live
         charts; dropping our reference without destroying leaks the old one
         (and its resize/animation listeners) for the life of the session. */
      if (charts[id]) { try { charts[id].destroy(); } catch (e) {} }
      charts[id] = new Chart(el, { type: type, data: { labels: spec.labels || [], datasets: datasets }, options: opts });
    });
  }
  function hexToRgba(hex, a) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    return "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + a + ")";
  }

  /* ---------------- breakdown: per-campaign / per-account reporting ----------
     A channel total answers "how did Meta do". It does not answer "which of my
     four campaigns did that". `payload.breakdown` carries the individual
     campaigns (or social accounts, or locations) and the portal recombines them
     for whatever the client selects — one, several, or all.

     Aggregation is declared, not guessed, because the arithmetic differs per
     metric. Summing spend is right; summing ROAS is nonsense. So each metric
     says how it combines:
       sum    — add the selected values
       avg    — mean across the selected entities
       ratio  — Σnumerator / Σdenominator, which is the ONLY correct way to
                recompute a rate for a subset (averaging per-campaign ROAS
                weights a $50 campaign the same as a $5,000 one)
       first  — not combinable; shown only when exactly one entity is selected
  */
  var breakdownSel = {};   /* view -> array of selected entity ids, or null = all */

  function fmtMetric(v, format) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    switch (format) {
      case "money":   return money(v);
      case "money2":  return "$" + v.toFixed(2);
      case "int":     return compact(Math.round(v));
      case "decimal": return (Math.round(v * 10) / 10).toLocaleString();
      case "percent": return (Math.round(v * 10) / 10) + "%";
      case "x":       return (Math.round(v * 10) / 10) + "x";
      case "position":return (Math.round(v * 10) / 10);
      default:        return compact(v);
    }
  }

  function aggregate(def, items) {
    if (!items.length) return null;
    var vals = items.map(function (it) { return num((it.values || {})[def.key]); });
    switch (def.agg) {
      case "ratio": {
        var n = 0, d = 0;
        items.forEach(function (it) {
          n += num((it.values || {})[def.num]);
          d += num((it.values || {})[def.den]);
        });
        return d ? n / d : null;
      }
      case "avg":
        /* Unweighted. Correct only when the entities are comparable in size. */
        return vals.reduce(function (a, b) { return a + b; }, 0) / items.length;
      case "wavg": {
        /* Weighted mean — what an average position or average rate actually
           needs. A 6-keyword group must not move the average as much as a
           34-keyword one. */
        var wn = 0, wd = 0;
        items.forEach(function (it) {
          var w = num((it.values || {})[def.weight]);
          wn += num((it.values || {})[def.key]) * w;
          wd += w;
        });
        return wd ? wn / wd : null;
      }
      case "first":
        return items.length === 1 ? vals[0] : null;
      case "max": return Math.max.apply(null, vals);
      case "min": return Math.min.apply(null, vals);
      default:
        return vals.reduce(function (a, b) { return a + b; }, 0);
    }
  }

  function selectedItems(bd, view) {
    var sel = breakdownSel[view];
    var items = bd.items || [];
    if (!sel || !sel.length) return items.slice();
    var hit = items.filter(function (it) { return sel.indexOf(it.id) !== -1; });
    /* Campaigns start and stop between periods, so a selection carried over
       from the last period can match nothing in this one. Falling back to all
       beats showing a page of em-dashes. */
    if (!hit.length) { breakdownSel[view] = null; return items.slice(); }
    return hit;
  }

  function renderBreakdown(host, bd, view) {
    if (!host) return;
    host.innerHTML = "";
    if (!bd || !(bd.items || []).length) return;

    var defs = (bd.metrics || []).filter(Boolean);
    var noun = bd.label || "Items";
    var all = bd.items;
    var sel = breakdownSel[view];
    var isAll = !sel || !sel.length || sel.length === all.length;

    var panel = document.createElement("div");
    panel.className = "pl-panel pl-bd";
    panel.innerHTML =
      '<div class="pl-panel-head"><h3>' + esc(noun) + "</h3>" +
      '<span class="pl-dim pl-bd-count"></span></div>' +
      '<p class="pl-muted pl-bd-hint">Select one, several, or all to see how they combine.</p>' +
      '<div class="pl-chips" role="group" aria-label="Select ' + esc(noun.toLowerCase()) + '"></div>' +
      '<div class="pl-bd-out"></div>';
    var chipHost = panel.querySelector(".pl-chips");
    var out = panel.querySelector(".pl-bd-out");
    var countEl = panel.querySelector(".pl-bd-count");

    function chip(id, label, note, active) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pl-chip" + (active ? " on" : "");
      b.setAttribute("aria-pressed", active ? "true" : "false");
      b.innerHTML = '<span class="c-nm">' + esc(label) + "</span>" +
                    (note ? '<span class="c-note">' + esc(note) + "</span>" : "");
      b.addEventListener("click", function () { toggle(id); });
      return b;
    }

    function toggle(id) {
      if (id === "__all") { breakdownSel[view] = null; return paint(); }
      var cur = breakdownSel[view];
      if (!cur || !cur.length || cur.length === all.length) {
        /* Coming from "All", clicking one entity means "just this one" — that is
           what people expect from a filter, rather than de-selecting one of N. */
        breakdownSel[view] = [id];
      } else {
        var i = cur.indexOf(id);
        if (i === -1) cur.push(id);
        else cur.splice(i, 1);
        if (!cur.length) breakdownSel[view] = null;   /* never leave it empty */
      }
      paint();
    }

    function paint() {
      var s = breakdownSel[view];
      var on = !s || !s.length || s.length === all.length;
      var items = selectedItems(bd, view);

      chipHost.innerHTML = "";
      chipHost.appendChild(chip("__all", "All " + noun.toLowerCase(), all.length + "", on));
      all.forEach(function (it) {
        chipHost.appendChild(chip(it.id, it.name, it.note || "", !on && s.indexOf(it.id) !== -1));
      });

      countEl.textContent = on
        ? "All " + all.length + " selected"
        : items.length + " of " + all.length + " selected";

      out.innerHTML = "";

      /* combined figures for the selection */
      if (defs.length) {
        var kpiRow = document.createElement("div");
        kpiRow.className = "pl-kpis pl-bd-kpis";
        kpiRow.innerHTML = defs.map(function (d) {
          var v = aggregate(d, items);
          var note = (d.agg === "ratio" || d.agg === "avg") && items.length > 1
            ? '<div class="k-delta">combined</div>' : "";
          return '<div class="pl-kpi"><div class="k-label">' + esc(d.label) + "</div>" +
                 '<div class="k-value">' + esc(fmtMetric(v, d.format)) + "</div>" + note + "</div>";
        }).join("");
        out.appendChild(kpiRow);
      }

      /* combined time series */
      var chartDefs = defs.filter(function (d) {
        return d.chart && all.some(function (it) { return it.series && it.series[d.key]; });
      });
      if (chartDefs.length && (bd.labels || []).length) {
        var datasets = chartDefs.map(function (d, i) {
          var sums = bd.labels.map(function (_, ix) {
            var t = 0;
            items.forEach(function (it) {
              var arr = (it.series || {})[d.key];
              if (arr && isFinite(Number(arr[ix]))) t += Number(arr[ix]);
            });
            return t;
          });
          return { label: d.label, data: sums, color: i === 0 ? "blue" : "green", fill: i === 0 };
        });
        var wrap = document.createElement("div");
        out.appendChild(wrap);
        renderCharts(wrap, [{
          title: (on ? "All " + noun.toLowerCase() : items.length + " selected") + " over time",
          type: "line", labels: bd.labels, datasets: datasets
        }], view + "-bd");
      }

      /* side-by-side comparison — only meaningful with more than one */
      if (items.length > 1 && defs.length) {
        var cols = [{ key: "__name", label: noun.replace(/s$/, "") }].concat(
          defs.map(function (d) { return { key: d.key, label: d.label, align: "num" }; }));
        var rows = items.map(function (it) {
          var r = { __name: it.name };
          defs.forEach(function (d) { r[d.key] = fmtMetric(aggregate(d, [it]), d.format); });
          return r;
        });
        var tw = document.createElement("div");
        out.appendChild(tw);
        renderTables(tw, [{ title: "Side by side", columns: cols, rows: rows }]);
      }
    }

    /* Attach BEFORE painting. Chart.js sizes a responsive chart from its
       container at construction time, and a container that is still in a
       detached subtree measures zero — the chart then renders blank until some
       later resize happens to rescue it. Same trap as an <img> that is given a
       src before it is in the document. */
    host.appendChild(panel);
    paint();
  }

  /* A channel's Overview band used to be three numbers in a very wide white
     box. The channel already carries a time series for its own page, so draw it
     small here: the band then says "and this is the shape of it" at a glance. */
  function sparkline(report) {
    var ch = report && report.payload && report.payload.charts;
    if (!ch || !ch.length) return "";
    /* Only a time series may be drawn as a sparkline. A bar chart is usually
       categorical ("reach by format"), and a line through categories invents a
       trend that does not exist. */
    var type = ch[0].type || "line";
    if (type !== "line") return "";
    var ds = (ch[0].datasets || [])[0];
    var data = (ds && ds.data || []).map(Number).filter(function (n) { return isFinite(n); });
    if (data.length < 2) return "";

    var W = 148, H = 40, pad = 3;
    var lo = Math.min.apply(null, data), hi = Math.max.apply(null, data);
    var span = (hi - lo) || 1;
    var pts = data.map(function (v, i) {
      var x = pad + (i / (data.length - 1)) * (W - pad * 2);
      var y = H - pad - ((v - lo) / span) * (H - pad * 2);
      return [x, y];
    });
    var line = pts.map(function (p, i) {
      return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1);
    }).join(" ");
    var area = line + " L" + pts[pts.length - 1][0].toFixed(1) + " " + H + " L" +
               pts[0][0].toFixed(1) + " " + H + " Z";
    var rising = data[data.length - 1] >= data[0];
    var col = rising ? PALETTE.green : PALETTE.blue;
    var uid = "sp" + (sparkline._n = (sparkline._n || 0) + 1);
    var last = pts[pts.length - 1];

    return '<svg class="pl-spark" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H +
      '" aria-hidden="true" focusable="false">' +
      '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + col + '" stop-opacity="0.20"/>' +
        '<stop offset="100%" stop-color="' + col + '" stop-opacity="0"/>' +
      "</linearGradient></defs>" +
      '<path d="' + area + '" fill="url(#' + uid + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + col +
        '" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) +
        '" r="2.6" fill="' + col + '"/></svg>';
  }

  function cell(val, col) {
    if (val && typeof val === "object") {
      var cls = val.dir === "up" ? "up" : val.dir === "down" ? "down" : "";
      return '<span class="pl-delta ' + cls + '">' + esc(deltaText(val.dir, val.text)) + "</span>";
    }
    return esc(val);
  }
  function renderTables(host, tables) {
    if (!host) return;
    host.innerHTML = "";
    if (!tables || !tables.length) return;
    tables.slice(0, MAX_TABLES).forEach(function (t) {
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
          return '<div class="pl-panel pl-chan"><div class="pl-panel-head"><h3>' + esc(c.label) + "</h3></div>" +
            '<p class="pl-muted" style="margin:0;font-size:0.9rem">Report being prepared for this period.</p></div>';
        }
        var s = (r.payload && r.payload.summary) || {};
        var mini = (s.cards || []).slice(0, 4).map(function (k) {
          return '<div class="pl-mini"><div class="m-label">' + esc(k.label) + "</div>" +
                 '<div class="m-value">' + esc(k.value) + "</div></div>";
        }).join("");
        return '<div class="pl-panel pl-chan"><div class="pl-panel-head"><h3>' + esc(c.label) + "</h3>" +
          '<button class="pl-btn ghost sm" data-goto="' + c.view + '">View full report →</button></div>' +
          '<div class="pl-chan-body"><div class="pl-minis">' + mini + "</div>" +
          sparkline(r) + "</div></div>";
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
    var bdHost    = document.querySelector('[data-breakdown="' + view + '"]');
    var emptyHost = document.querySelector('[data-empty="' + view + '"]');
    if (emptyHost) { emptyHost.hidden = true; emptyHost.innerHTML = ""; }
    renderMeta(document.getElementById("pl-meta-" + view), row);
    if (!row) {
      renderKpis(kpiHost, null);
      if (chartHost) chartHost.innerHTML = "";
      if (tableHost) tableHost.innerHTML = "";
      if (bdHost) bdHost.innerHTML = "";
      emptyState(view, cfg.title);
      return;
    }
    var pl = row.payload || {};
    renderKpis(kpiHost, pl.kpis);
    renderCharts(chartHost, pl.charts, view);
    renderBreakdown(bdHost, pl.breakdown, view);
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

  /* ---------------- navigation ----------------
     Views are addressable by URL hash (#meta, #seo, ...) so a refresh keeps the
     client on the page they were reading, the browser Back button works, and a
     link to one channel can be sent to them directly. */
  var hashLock = false;
  function viewFromHash() {
    var h = (location.hash || "").replace(/^#/, "");
    return VIEWS[h] ? h : "";
  }
  function showView(view, fromHash) {
    if (!VIEWS[view]) view = "overview";
    /* A client whose plan does not include a channel must not be able to land on
       that channel's view by typing or keeping its hash. */
    if (VIEWS[view].section && !hasSection(VIEWS[view].section)) view = "overview";
    currentView = view;
    if (!fromHash) {
      hashLock = true;
      try {
        if (history && history.replaceState) history.replaceState(null, "", "#" + view);
        else location.hash = view;
      } catch (e) { location.hash = view; }
      hashLock = false;
    }
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
  window.addEventListener("hashchange", function () {
    if (hashLock) return;
    var v = viewFromHash();
    if (v && v !== currentView) showView(v, true);
  });
  qsa("[data-open-nav]").forEach(function (b) {
    b.addEventListener("click", function () { app.classList.add("nav-open"); });
  });
  qsa("[data-close-nav]").forEach(function (b) {
    b.addEventListener("click", function () { app.classList.remove("nav-open"); });
  });

  /* ---------------- data loading ---------------- */
  function loadPeriods() {
    /* Scope every read to one client explicitly. A client is already confined to
       their own rows by RLS, but an ADMIN is not — the policies deliberately let
       an admin read every client, so an unscoped select during "view as" would
       merge every client's periods into one list and load the wrong company's
       numbers under this company's name. The filter must be in the query, not
       left to RLS. */
    return ctx.sb.from("report_cache")
      .select("period_start, period_end")
      .eq("client_id", ctx.clientId)
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
      .eq("client_id", ctx.clientId)   /* see loadPeriods — admins can read every client */
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
    var start = viewFromHash() || "overview";
    if (!ctx.clientId) { showView(start); renderAll(); return; }
    loadPeriods().then(function (list) {
      showView(start);
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
