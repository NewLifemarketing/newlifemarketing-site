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
    organic:  { title: "Social Media", platform: "organic", section: "organic" },
    website:  { title: "Website", platform: "website", section: "website" },
    onboarding: { title: "Onboarding", platform: null, section: null }
  };
  /* Overview channel blocks, in display order */
  var CHANNELS = [
    { view: "meta", platform: "meta", label: "Meta Ads" },
    { view: "google", platform: "google_ads", label: "Google Ads" },
    { view: "seo", platform: "seo", label: "SEO" },
    { view: "gbp", platform: "gbp", label: "Google Business Profile" },
    { view: "organic", platform: "organic", label: "Social Media" },
    { view: "website", platform: "website", label: "Website" }
  ];

  /* The weekly reporting job writes each run to its OWN table and registers it
     in report_runs (see newlife-reporting/db/schema.sql). The portal therefore
     has two sources of history:

       report_runs + report_<slug>_<date>   every run from the new job
       report_cache                         the months loaded before it existed

     Both are listed in one period dropdown and both render through the same
     renderers, because a client should not be able to tell which era of the
     system produced the week they are looking at. */
  var REPORT_TO_PLATFORM = {
    meta_ads: "meta",
    google_ads: "google_ads",
    seo: "seo",
    gbp: "gbp",
    social: "organic",
    website: "website",
    overall: "overall"
  };

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
     arrow. Strip a leading one rather than rendering "▲ ▲ 3.1".

     `dir` means COLOUR, not arithmetic (see REPORT-DATA-FORMAT.md): a cost that
     fell is good, so it is sent as dir:"up" to render green. Deriving the arrow
     from `dir` therefore drew ▲ next to a number that had gone DOWN. Optional
     `trend` carries the real direction of movement and wins when present;
     without it the old behaviour is unchanged. */
  function deltaText(dir, text, trend) {
    var a = arrow(trend || dir);
    return a + String(text || "").replace(/^\s*[▲▼↑↓▴▾]\s*/, "");
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
      var dtext = d ? deltaText(d.dir, d.text, d.trend).trim() : "";
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
      return '<span class="pl-delta ' + cls + '">' + esc(deltaText(val.dir, val.text, val.trend)) + "</span>";
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

  /* ---------------- automatic period-over-period deltas ----------------
     A payload may carry a hand-written delta ("12% vs prev"). Most do not —
     none of the 48 months of loaded history does. Rather than ask whoever
     builds each payload to work the change out by hand across five channels
     and ten clients every fortnight (which will eventually be wrong, and wrong
     silently), the portal derives it from the period before.

     A hand-written delta always wins. This only fills in the gaps. */

  var prevReports = {};      /* platform -> previous period's row */
  var prevComparable = false; /* are the two periods the same rough length? */
  var prevLabel = "";

  function periodDays(p) {
    if (!p) return 0;
    var a = new Date(p.start + "T00:00:00Z"), b = new Date(p.end + "T00:00:00Z");
    if (isNaN(a) || isNaN(b)) return 0;
    return Math.round((b - a) / 86400000) + 1;
  }

  /* Values in `kpis` are pre-formatted for display ("$34.6K", "2.4%", "3.9x"),
     so the number has to be read back out of the string. */
  function parseValue(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (v == null) return null;
    var t = String(v).trim();
    var m = t.match(/-?[\d,]*\.?\d+/);
    if (!m) return null;
    var n = parseFloat(m[0].replace(/,/g, ""));
    if (!isFinite(n)) return null;
    var after = t.slice(t.indexOf(m[0]) + m[0].length);
    if (/^\s*k/i.test(after)) n *= 1e3;
    else if (/^\s*m/i.test(after)) n *= 1e6;
    if (/^\s*\(/.test(t) || /^-/.test(t)) n = -Math.abs(n);
    return n;
  }

  /* A rate, multiple or rating moves in POINTS — 2.4% to 2.7% is +0.3, not
     +12.5%. A count or a dollar amount moves in percent. Mirrors how the
     hand-written examples in REPORT-DATA-FORMAT.md are written. */
  function valueUnit(v) {
    var t = String(v == null ? "" : v);
    if (/%/.test(t)) return "%";
    if (/\u2605/.test(t)) return "\u2605";
    if (/\dx\b/i.test(t) || /x$/i.test(t.trim())) return "x";
    return null;
  }

  /* For these, DOWN is the good direction, so the chip should be green when the
     number falls. `dir` is colour only; `trend` carries the real movement. */
  var LOWER_IS_BETTER = /(^|[^a-z])(cost|cpc|cpa|cpl|cpm|spend per|cost per|cost \/)/i;

  function computeDelta(label, nowVal, prevVal) {
    var a = parseValue(nowVal), b = parseValue(prevVal);
    if (a === null || b === null) return null;
    if (b === 0) return null;                 /* no honest percentage off zero */
    var unit = valueUnit(nowVal);
    var diff = a - b;
    if (Math.abs(diff) < 1e-9) return { dir: "flat", trend: "flat", text: "no change" };

    var text;
    if (unit === "%" || unit === "x" || unit === "\u2605") {
      var d = Math.abs(diff);
      text = (Math.round(d * 100) / 100) + (unit === "%" ? "%" : "");
    } else {
      text = Math.round(Math.abs(diff / b) * 1000) / 10 + "%";
    }

    var trend = diff > 0 ? "up" : "down";
    var good = LOWER_IS_BETTER.test(String(label)) ? diff < 0 : diff > 0;
    return { dir: good ? "up" : "down", trend: trend, text: text + " vs prev" };
  }

  /* Fill in any KPI that has no delta of its own, matching on label. */
  function withDeltas(kpis, prevKpis) {
    if (!kpis || !kpis.length) return kpis;
    if (!prevComparable || !prevKpis || !prevKpis.length) return kpis;
    var prevBy = {};
    prevKpis.forEach(function (k) { if (k && k.label) prevBy[String(k.label).toLowerCase()] = k.value; });
    return kpis.map(function (k) {
      if (!k || k.delta) return k;            /* hand-written wins */
      var pv = prevBy[String(k.label || "").toLowerCase()];
      if (pv === undefined) return k;
      var d = computeDelta(k.label, k.value, pv);
      if (!d) return k;
      var out = {};
      Object.keys(k).forEach(function (kk) { out[kk] = k[kk]; });
      out.delta = d;
      return out;
    });
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
    /* Overview totals come from summary.metrics, which are real numbers rather
       than formatted strings — so the comparison here is exact arithmetic, not
       a value parsed back out of "$34.6K". */
    function pm(platform, key) {
      var r = prevReports[platform];
      var sm = r && r.payload && r.payload.summary;
      return sm && sm.metrics ? num(sm.metrics[key]) : null;
    }
    function pair(label, nowNum, prevNum, fmt) {
      var card = { label: label, value: fmt(nowNum) };
      if (prevComparable && prevNum !== null && prevNum !== 0) {
        var d = computeDelta(label, nowNum, prevNum);
        if (d) card.delta = d;
      }
      return card;
    }
    function prevSum() {
      var t = null;
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (v !== null) t = (t === null ? 0 : t) + v;
      }
      return t;
    }
    var cards = [];
    if (present("meta") || present("google_ads")) {
      cards.push(pair("Total ad spend", spend, prevSum(pm("meta", "spend"), pm("google_ads", "spend")), money));
      cards.push(pair("Leads / conversions", leads, prevSum(pm("meta", "leads"), pm("google_ads", "leads")), compact));
      if (value > 0) cards.push(pair("Conversion value", value,
        prevSum(pm("meta", "conversion_value"), pm("google_ads", "conversion_value")), money));
    }
    if (present("gbp")) cards.push(pair("GBP calls", m("gbp", "calls"), pm("gbp", "calls"), compact));
    if (present("organic")) cards.push(pair("Organic engagements", m("organic", "engagements"), pm("organic", "engagements"), compact));
    if (present("seo")) cards.push(pair("Keywords in top 10", m("seo", "keywords_top10"), pm("seo", "keywords_top10"), compact));
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
    var metaHost = document.getElementById("pl-meta-" + view);
    renderMeta(metaHost, row);
    renderPdfLink(metaHost, row);
    if (!row) {
      renderKpis(kpiHost, null);
      if (chartHost) chartHost.innerHTML = "";
      if (tableHost) tableHost.innerHTML = "";
      if (bdHost) bdHost.innerHTML = "";
      emptyState(view, cfg.title);
      return;
    }
    var pl = row.payload || {};
    var prevRow = prevReports[cfg.platform];
    renderKpis(kpiHost, withDeltas(pl.kpis, prevRow && prevRow.payload ? prevRow.payload.kpis : null));
    renderCharts(chartHost, pl.charts, view);
    renderBreakdown(bdHost, pl.breakdown, view);
    renderTables(tableHost, pl.tables);
  }

  function renderAll() {
    Object.keys(charts).forEach(function (k) { try { charts[k].destroy(); } catch (e) {} });
    charts = {};
    renderOverview();
    ["meta", "google", "gbp", "seo", "organic", "website"].forEach(renderChannel);
    /* The Overall report is a stored row like any other; its PDF belongs on
       the Overview page, which is the screen version of the same thing. */
    renderPdfLink(document.getElementById("pl-meta-overview"), reports.overall);
    /* Marks which period the list is currently showing. */
    renderHistory();
    /* Everything above renders every channel, but only one view is visible —
       the others measured zero. Size whichever is on screen. */
    resizeChartsIn(currentView);
  }

  /* ---------------- report history ----------------
     Every period this client has ever been sent, newest first, each row
     loading from the table its own run wrote. The current period is marked
     rather than hidden, so the list is the complete record and a client
     counting their reports gets the number they expect. */
  var historyOpen = false;

  function renderHistory() {
    var host = document.getElementById("pl-history");
    var body = document.getElementById("pl-history-body");
    var toggle = document.getElementById("pl-history-toggle");
    if (!host || !body || !toggle) return;

    /* One period is simply the current one; there is no history to offer. */
    if (periods.length < 2) { host.hidden = true; return; }
    host.hidden = false;
    toggle.querySelector("span").textContent =
      "See previous periods (" + (periods.length - 1) + ")";

    body.innerHTML =
      '<ul class="pl-history-list">' +
      periods.map(function (p, i) {
        var isCurrent = current && p.start === current.start && p.end === current.end;
        return '<li class="pl-history-row' + (isCurrent ? " current" : "") + '">' +
          '<button class="pl-history-open" type="button" data-period="' + i + '">' +
            '<span class="h-range">' + esc(p.label) + "</span>" +
            (isCurrent ? '<span class="h-now">Showing</span>' : "") +
          "</button>" +
          '<span class="h-files" data-files="' + i + '"></span>' +
        "</li>";
      }).join("") +
      "</ul>";

    qsa(".pl-history-open").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = periods[parseInt(b.getAttribute("data-period"), 10)];
        if (!p) return;
        if (periodSel) periodSel.value = String(periods.indexOf(p));
        loadPeriod(p).then(function () { window.scrollTo(0, 0); });
      });
    });

    /* The PDF links for a past period are in that period's own table, so they
       are fetched only once its row is expanded — otherwise opening the list
       would fire one query per week the client has been with us. */
    loadHistoryFiles();
  }

  /* table name -> the PDF links in it. The LINKS are cached, not merely the
     fact that they were fetched: opening another period rebuilds the list's
     markup, and a cache of booleans would skip the refetch and leave every row
     blank from then on. */
  var filesByTable = {};

  function paintHistoryFiles() {
    periods.forEach(function (p, i) {
      var host = document.querySelector('[data-files="' + i + '"]');
      if (!host || !p.table) return;
      var rows = filesByTable[p.table];
      if (!rows) return;
      host.innerHTML = rows.map(function (x) {
        return '<a class="pl-pdf" href="' + esc(x.pdf_url) + '" target="_blank" rel="noopener">' +
          esc(x.title || x.report) + "</a>";
      }).join("");
    });
  }

  var filesPending = {};
  function loadHistoryFiles() {
    if (!historyOpen) return;
    paintHistoryFiles();
    /* Overall first, then the channels in sidebar order. */
    var order = ["overall", "meta_ads", "google_ads", "seo", "gbp", "social", "website"];
    periods.forEach(function (p) {
      if (!p.table || filesByTable[p.table] || filesPending[p.table]) return;
      filesPending[p.table] = true;
      ctx.sb.from(p.table)
        .select("report, title, pdf_url")
        .eq("client_id", ctx.clientId)
        .then(function (r) {
          var rows = (r.data || []).filter(function (x) { return x.pdf_url; });
          rows.sort(function (a, b) { return order.indexOf(a.report) - order.indexOf(b.report); });
          filesByTable[p.table] = rows;
          paintHistoryFiles();
        })
        .catch(function () { filesPending[p.table] = false; });
    });
  }

  (function wireHistory() {
    var toggle = document.getElementById("pl-history-toggle");
    var body = document.getElementById("pl-history-body");
    if (!toggle || !body) return;
    toggle.addEventListener("click", function () {
      historyOpen = !historyOpen;
      body.hidden = !historyOpen;
      toggle.setAttribute("aria-expanded", historyOpen ? "true" : "false");
      toggle.classList.toggle("open", historyOpen);
      loadHistoryFiles();
    });
  })();

  /* The PDF for whatever is on screen. A client reading a channel page should
     not have to go to the history list to get that channel's PDF. */
  function renderPdfLink(host, row) {
    if (!host) return;
    var existing = host.querySelector(".pl-pdf-bar");
    if (existing) existing.remove();
    if (!row || !row.pdf_url) return;
    var bar = document.createElement("div");
    bar.className = "pl-pdf-bar";
    bar.innerHTML = '<a class="pl-pdf" href="' + esc(row.pdf_url) + '" target="_blank" rel="noopener">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
      '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>' +
      "Download this report (PDF)</a>";
    host.appendChild(bar);
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

  /* Charts built while their view was display:none measured a zero-sized
     container and drew nothing, staying blank until an unrelated window resize
     happened to rescue them — which is how this reached production looking fine.

     Resizing on reveal is the fix, but WHEN matters: `.pl-view.active` runs a
     0.25s fade that animates `transform: translateY(6px)`. Chart.js measures
     the container mid-animation, gets a bogus size and caches it, so a resize
     fired in the first frames is silently thrown away. Wait for the animation
     to finish — `animationend` normally, with timed attempts as a backstop for
     when it never fires (reduced-motion, interrupted animation, no support).
     Every attempt stops early once the canvases have real dimensions. */
  function resizeChartsIn(view) {
    if (typeof Chart === "undefined" || !Chart.getChart) return;
    var sec = document.querySelector('.pl-view[data-view="' + view + '"]');
    if (!sec) return;

    function attempt() {
      var canvases = qsa('.pl-view[data-view="' + view + '"] canvas');
      if (!canvases.length) return true;          /* nothing to size: done */
      var allSized = true;
      canvases.forEach(function (c) {
        var inst = Chart.getChart(c);
        if (!inst) return;
        try { inst.resize(); } catch (e) {}
        if (!c.width || !c.height) allSized = false;
      });
      return allSized;
    }

    var done = false;
    function tryOnce() {
      if (done) return;
      if (attempt()) done = true;
    }

    sec.addEventListener("animationend", function onEnd() {
      sec.removeEventListener("animationend", onEnd);
      tryOnce();
    });
    /* 250ms is the animation; 300 lands just after it, 650 covers a slow first
       paint. Both no-op once the charts are correct. */
    setTimeout(tryOnce, 300);
    setTimeout(tryOnce, 650);
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
    /* Charts constructed while their view was display:none measured a
       zero-sized container and drew nothing. Chart.js re-measures only when the
       element itself resizes, which never happens for a panel that was simply
       revealed — so the chart stayed blank until an unrelated window resize
       rescued it. That is exactly why this reached production looking fine.
       Resize this view's charts once it is genuinely on screen. */
    resizeChartsIn(view);
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

  /* ---------------- new-format rows -> payload ----------------
     The weekly job stores plain figures: { metrics: { clicks: { text, value } },
     tables: [{ title, headers, rows }] }. Every renderer above already speaks
     the older `payload` shape, so a row is translated into that shape rather
     than the renderers being rewritten around a second one. One render path,
     whichever era wrote the row. */

  var METRIC_LABELS = {
    spend: "Amount spent", cost: "Cost", impressions: "Impressions", reach: "Reach",
    clicks: "Clicks", ctr: "CTR", cpc: "Cost per click", avg_cpc: "Average CPC",
    cpm: "CPM", results: "Results", cost_per_result: "Cost per result",
    conversions: "Conversions", cost_per_conversion: "Cost per conversion",
    conversion_rate: "Conversion rate",
    gsc_clicks: "Search clicks", gsc_impressions: "Search impressions",
    gsc_ctr: "Search CTR", gsc_position: "Average position",
    visibility: "Visibility", estimated_traffic: "Estimated organic traffic",
    keywords_tracked: "Keywords tracked", avg_position: "Average tracked position",
    top3: "Keywords in top 3", top10: "Keywords in top 10", top20: "Keywords in top 20",
    authority_score: "Authority score", backlinks: "Backlinks",
    referring_domains: "Referring domains",
    searches: "Profile searches", views_search: "Views on Search",
    views_maps: "Views on Maps", calls: "Calls", messages: "Messages",
    bookings: "Bookings", directions: "Direction requests",
    website_clicks: "Website clicks", reviews: "Total reviews", rating: "Average rating",
    fb_reach: "Facebook reach", ig_reach: "Instagram reach",
    fb_visits: "Facebook visits", ig_visits: "Instagram visits",
    fb_followers: "Facebook followers gained", ig_followers: "Instagram followers gained",
    interactions: "Content interactions", link_clicks: "Link clicks", posts: "Posts published",
    users: "Users", new_users: "New users", sessions: "Sessions",
    engaged_sessions: "Engaged sessions", engagement_rate: "Engagement rate",
    avg_engagement_time: "Average engagement time", views: "Page views",
    form_submissions: "Form submissions"
  };

  /* The Overview reads a fixed set of names off summary.metrics — `spend`,
     `leads`, `calls`, `engagements`, `keywords_top10` — and does arithmetic
     across channels with them. The weekly job stores each source's own name
     for the same thing ("cost" on Google, "spend" on Meta), so the translation
     has to happen here or the Overview silently totals zero. */
  var SUMMARY_KEYS = {
    meta: { spend: "spend", leads: "results" },
    google_ads: { spend: "cost", leads: "conversions" },
    seo: { keywords_top10: "top10" },
    gbp: { calls: "calls" },
    organic: { engagements: "interactions" },
    website: { leads: "form_submissions" }
  };

  /* The four figures each channel shows on its Overview block. Chosen per
     channel rather than "the first four stored", so the block leads with the
     numbers that matter instead of whichever the dashboard happened to list
     first. */
  var CARD_KEYS = {
    meta: ["spend", "impressions", "clicks", "results"],
    google_ads: ["cost", "impressions", "clicks", "conversions"],
    seo: ["gsc_clicks", "gsc_impressions", "gsc_position", "top10"],
    gbp: ["searches", "calls", "directions", "website_clicks"],
    organic: ["fb_reach", "ig_reach", "interactions", "posts"],
    website: ["users", "sessions", "engagement_rate", "form_submissions"]
  };

  function adaptRow(row) {
    var platform = REPORT_TO_PLATFORM[row.report] || row.report;
    var metrics = row.metrics || {};

    var kpis = [];
    Object.keys(metrics).forEach(function (key) {
      var m = metrics[key] || {};
      if (m.value == null && !m.text) return;   /* a metric that could not be read stays off the page */
      kpis.push({
        label: METRIC_LABELS[key] || key.replace(/_/g, " "),
        value: m.text != null && m.text !== "" ? m.text : String(m.value)
      });
    });

    var tables = (row.tables || []).map(function (t) {
      var headers = t.headers || [];
      var columns = headers.map(function (h, i) {
        return { key: "c" + i, label: h, align: i === 0 ? null : "num" };
      });
      var rows = (t.rows || []).map(function (cells) {
        var o = {};
        cells.forEach(function (c, i) { o["c" + i] = c; });
        return o;
      });
      return { title: t.title, columns: columns, rows: rows };
    });

    var sumKeys = SUMMARY_KEYS[platform] || {};
    var summary = { metrics: {}, cards: [] };
    Object.keys(sumKeys).forEach(function (out) {
      var m = metrics[sumKeys[out]];
      if (m && m.value != null) summary.metrics[out] = m.value;
    });
    (CARD_KEYS[platform] || []).forEach(function (key) {
      var m = metrics[key];
      if (!m || (m.value == null && !m.text)) return;
      summary.cards.push({
        label: METRIC_LABELS[key] || key.replace(/_/g, " "),
        value: m.text != null && m.text !== "" ? m.text : String(m.value)
      });
    });

    return {
      platform: platform,
      report: row.report,
      period_start: row.period_start,
      period_end: row.period_end,
      refreshed_at: row.captured_at || row.created_at,
      is_sample: false,
      pdf_url: row.pdf_url || null,
      account: row.account || null,
      payload: {
        summary: summary,
        kpis: kpis,
        charts: [],
        tables: tables,
        notes: row.notes || [],
        warnings: row.warnings || []
      }
    };
  }

  /* ---------------- data loading ---------------- */
  function loadPeriods() {
    /* Scope every read to one client explicitly. A client is already confined to
       their own rows by RLS, but an ADMIN is not — the policies deliberately let
       an admin read every client, so an unscoped select during "view as" would
       merge every client's periods into one list and load the wrong company's
       numbers under this company's name. The filter must be in the query, not
       left to RLS. */
    /* Completed runs from the weekly job, newest first. A run still being
       built is left out: half its channels are missing, and a client opening
       it mid-run would see a week that looks like a collapse. */
    var runs = ctx.sb.from("report_runs")
      .select("table_name, run_date, period_start, period_end")
      .eq("client_id", ctx.clientId)
      .eq("status", "complete")
      .order("period_end", { ascending: false })
      .then(function (r) { return r.data || []; })
      .catch(function () { return []; });

    var cached = ctx.sb.from("report_cache")
      .select("period_start, period_end")
      .eq("client_id", ctx.clientId)
      .order("period_start", { ascending: false })
      .then(function (r) { return r.data || []; })
      .catch(function () { return []; });

    return Promise.all([runs, cached]).then(function (res) {
      var seen = {}, out = [];
      function add(start, end, table, runDate) {
        var k = start + "|" + end;
        if (seen[k]) return;
        seen[k] = 1;
        out.push({
          start: start, end: end, table: table || null, run_date: runDate || null,
          label: fmtRange(start, end)
        });
      }
      /* Runs win on a collision: if a week exists in both, the per-run table
         is the one the PDFs were built from. */
      res[0].forEach(function (row) { add(row.period_start, row.period_end, row.table_name, row.run_date); });
      res[1].forEach(function (row) { add(row.period_start, row.period_end, null, null); });
      out.sort(function (a, b) { return a.end < b.end ? 1 : a.end > b.end ? -1 : 0; });

      periods = out;
      if (periodSel) {
        periodSel.innerHTML = out.map(function (p, i) {
          return '<option value="' + i + '">' + esc(p.label) + "</option>";
        }).join("");
        periodSel.hidden = !out.length || currentView === "onboarding";
      }
      renderHistory();
      return out;
    });
  }
  function fetchPeriod(p) {
    /* A period from the weekly job lives in its own table; one from before it
       lives in report_cache. Same filter on client_id either way: a client is
       confined by RLS, but an admin deliberately is not, so during "view as"
       an unscoped select would merge every client's numbers into this one's
       report. The filter belongs in the query, not in the policy. */
    if (p.table) {
      return ctx.sb.from(p.table)
        .select("report, period_start, period_end, metrics, tables, totals, inbound, channels, notes, warnings, account, pdf_url, captured_at, created_at")
        .eq("client_id", ctx.clientId)
        .then(function (r) {
          var out = {};
          (r.data || []).forEach(function (row) {
            var adapted = adaptRow(row);
            /* `overall` is kept whatever the client's sections are: it is the
               summary of the channels they do have, and the Overview page
               links its PDF. */
            if (adapted.platform === "overall" || hasSection(adapted.platform)) {
              out[adapted.platform] = adapted;
            }
          });
          return out;
        })
        .catch(function () { return {}; });
    }

    return ctx.sb.from("report_cache")
      .select("platform, period_start, period_end, payload, is_sample, refreshed_at")
      .eq("client_id", ctx.clientId)
      .eq("period_start", p.start)
      .eq("period_end", p.end)
      .then(function (r) {
        var out = {};
        /* Only keep platforms this client is actually subscribed to, so a
           stored-but-unsubscribed report can never surface in the sidebar,
           a channel page or the Overview totals. */
        (r.data || []).forEach(function (row) {
          if (hasSection(row.platform)) out[row.platform] = row;
        });
        return out;
      });
  }

  function loadPeriod(p) {
    current = p;
    reports = {};
    prevReports = {};
    prevComparable = false;
    prevLabel = "";
    if (!p) { renderAll(); return Promise.resolve(); }

    /* The period before this one, for automatic deltas. `periods` is newest
       first, so the previous period is the next entry. */
    var idx = -1;
    for (var i = 0; i < periods.length; i++) {
      if (periods[i].start === p.start && periods[i].end === p.end) { idx = i; break; }
    }
    var prev = (idx >= 0 && idx + 1 < periods.length) ? periods[idx + 1] : null;

    /* History is monthly; going forward reporting is two-weekly. Comparing a
       14-day period against a 30-day one would show a ~50% "drop" that is
       nothing but the calendar. Only compare periods of a similar length, and
       otherwise show no delta at all rather than a misleading one. */
    if (prev) {
      var dn = periodDays(p), dp = periodDays(prev);
      prevComparable = !!(dn && dp && Math.abs(dn - dp) <= Math.max(dn, dp) * 0.25);
      prevLabel = prev.label;
    }

    return fetchPeriod(p).then(function (cur) {
      reports = cur;
      if (!prev || !prevComparable) { renderAll(); return; }
      return fetchPeriod(prev).then(function (pr) {
        prevReports = pr;
        renderAll();
      });
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
