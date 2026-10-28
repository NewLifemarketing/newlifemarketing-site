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
    seo:      { title: "Search Engine Optimization", platform: "seo", section: "seo" },
    organic:  { title: "Social Media Analytics", platform: "organic", section: "organic" },
    website:  { title: "Website Analytics", platform: "website", section: "website" },
    /* Not a reporting channel: the Friday video + PDF. No platform, and no
       section gate — every client gets it. */
    weekly:   { title: "Weekly Report", platform: null, section: null },
    onboarding: { title: "Onboarding", platform: null, section: null }
  };
  /* Overview channel blocks, in display order */
  var CHANNELS = [
    { view: "meta", platform: "meta", label: "Meta Ads" },
    { view: "google", platform: "google_ads", label: "Google Ads" },
    { view: "gbp", platform: "gbp", label: "Google Business Profile" },
    { view: "seo", platform: "seo", label: "Search Engine Optimization" },
    { view: "organic", platform: "organic", label: "Social Media Analytics" },
    { view: "website", platform: "website", label: "Website Analytics" }
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
    /* The period is already stated in full below, so repeating it as a tag was
       just noise. Only the sample badge earns the space. */
    var tag = row.is_sample ? '<span class="pl-sample-tag">Sample data</span>' : "";
    /* Weekly collector rows carry a report DATE, not a timestamp - rendering it
       as a datetime showed "8:00 p.m." the evening before, which is wrong and
       looks like a bug. */
    var upd = row.report_date
      ? ' <span class="pl-dim">· Report produced ' + esc(fmtDate(row.report_date)) + "</span>"
      : (row.refreshed_at ? ' <span class="pl-dim">· Last updated ' + esc(fmtUpdated(row.refreshed_at)) + "</span>" : "");
    /* Search Console does not finalise a day for about three days, so its
       window is shifted back. Labelling it with the report week would quietly
       overstate how recent the figures are. */
    var note = row.platform === "seo"
      ? '<br><span class="pl-dim" style="font-size:0.82rem">Search Console finalises data about three days late, ' +
        "so this window sits slightly behind the other channels.</span>"
      : "";
    el.innerHTML = '<p class="pl-muted" style="margin:0 0 1.25rem">Reporting period: <strong>' +
      esc(fmtRange(row.period_start, row.period_end)) + "</strong> " + tag + upd + note + "</p>";
  }

  function emptyState(view, label, reason) {
    var host = document.querySelector('[data-empty="' + view + '"]');
    if (!host) return;
    host.hidden = false;
    /* When the collector recorded WHY a source produced nothing, say so. An
       empty panel with no explanation looks like a broken portal; "we could
       not read it this week" is a different thing from "there was nothing". */
    var why = reason
      ? '<p class="pl-muted" style="margin:0.6rem 0 0;font-size:0.85rem">' + esc(reason) + "</p>"
      : "";
    host.innerHTML =
      '<div class="pl-panel" style="text-align:center;padding:3rem 1.5rem">' +
      '<div style="font-size:2rem;line-height:1;margin-bottom:0.75rem">📊</div>' +
      "<h3 style=\"margin:0 0 0.4rem\">" + (reason
        ? "No " + esc(label) + " figures for this week"
        : "Your first " + esc(label) + " report is being prepared") + "</h3>" +
      '<p class="pl-muted" style="margin:0;font-size:0.9rem">' + (reason
        ? "Everything else on this report is unaffected."
        : "As soon as we publish a report for this period it will appear here automatically.") +
      "</p>" + why + "</div>";
  }

  /* ---------------- automatic period-over-period deltas ----------------
     A payload may carry a hand-written delta ("12% vs prev"). Most do not —
     none of the 48 months of loaded history does. Rather than ask whoever
     builds each payload to work the change out by hand across five channels
     and ten clients every fortnight (which will eventually be wrong, and wrong
     silently), the portal derives it from the period before.

     A hand-written delta always wins. This only fills in the gaps. */

  var prevReports = {};      /* platform -> previous period's row */
  var weeklyRowForNotes = null; /* the collector row backing the current period */
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

    /* headline cards across channels.
       `has` and `m` are deliberately separate: a metric that was never
       collected must not become a zero on the Overview. "GBP calls 0" reads as
       "nobody rang this week" when the truth is "we could not read it", and
       the collectors are explicit that null is not zero. A card only appears
       when at least one contributing channel actually reported the number. */
    function has(platform, key) {
      var r = reports[platform];
      var sm = r && r.payload && r.payload.summary && r.payload.summary.metrics;
      return !!(sm && sm[key] !== undefined && sm[key] !== null);
    }
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
    if (has("meta", "spend") || has("google_ads", "spend")) {
      cards.push(pair("Total ad spend", spend, prevSum(pm("meta", "spend"), pm("google_ads", "spend")), money));
    }
    if (has("meta", "leads") || has("google_ads", "leads")) {
      cards.push(pair("Leads / conversions", leads, prevSum(pm("meta", "leads"), pm("google_ads", "leads")), compact));
    }
    if (has("meta", "conversion_value") || has("google_ads", "conversion_value")) {
      cards.push(pair("Conversion value", value,
        prevSum(pm("meta", "conversion_value"), pm("google_ads", "conversion_value")), money));
    }
    if (has("gbp", "calls")) cards.push(pair("GBP calls", m("gbp", "calls"), pm("gbp", "calls"), compact));
    if (has("organic", "engagements")) cards.push(pair("Organic engagements", m("organic", "engagements"), pm("organic", "engagements"), compact));
    if (has("seo", "keywords_top10")) cards.push(pair("Keywords in top 10", m("seo", "keywords_top10"), pm("seo", "keywords_top10"), compact));
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
      emptyState(view, cfg.title, weeklyFailureReason(weeklyRowForNotes, cfg.platform));
      return;
    }
    var pl = row.payload || {};
    var prevRow = prevReports[cfg.platform];
    renderKpis(kpiHost, withDeltas(pl.kpis, prevRow && prevRow.payload ? prevRow.payload.kpis : null));
    renderCharts(chartHost, pl.charts, view);
    renderBreakdown(bdHost, pl.breakdown, view);
    renderTables(tableHost, pl.tables);
  }

  var dirtyChannels = {};

  function renderAll() {
    Object.keys(charts).forEach(function (k) { try { charts[k].destroy(); } catch (e) {} });
    charts = {};
    renderOverview();
    /* Only the channel on screen is rendered now. The rest are marked and
       rendered the first time they are opened.

       This is not an optimisation. A Chart.js chart built against a container
       that measures zero — which is every hidden view — writes width:0 and
       height:0 onto its canvas and is then unrecoverable: resize(), clearing
       the inline style and a window resize event were all tried and none of
       them bring it back. The only reliable answer is to not build it until
       the container is genuinely on screen. */
    ["meta", "google", "gbp", "seo", "organic", "website"].forEach(function (v) {
      if (v === currentView) { dirtyChannels[v] = false; renderChannel(v); }
      else { dirtyChannels[v] = true; }
    });
    resizeChartsIn(currentView);
  }

  /* Render a channel once its panel is actually visible and settled. The view
     fade animates a transform for 0.25s and measuring through it gives a bogus
     size, so wait for the animation to finish (with timed fallbacks for when
     it never fires). */
  function renderChannelWhenVisible(view) {
    var sec = document.querySelector('.pl-view[data-view="' + view + '"]');
    if (!sec) { renderChannel(view); return; }
    var done = false;
    function go() {
      if (done) return;
      if (!sec.classList.contains("active")) return;   /* moved on already */
      done = true;
      renderChannel(view);
    }
    sec.addEventListener("animationend", function onEnd() {
      sec.removeEventListener("animationend", onEnd);
      go();
    });
    setTimeout(go, 300);
    setTimeout(go, 650);
  }

  /* ---------------- weekly collector metrics ----------------
     The collectors write one row per client per week into nine per-client
     tables, surfaced to the portal through the `client_weekly_metrics` view
     (the base tables have RLS with no policies, so the view is the only way
     in, and it filters to the signed-in client).

     Rather than a second rendering path, each weekly row is turned into the
     SAME payload shape the portal already renders. Everything downstream -
     KPI cards, charts, tables, automatic period-over-period deltas, chart
     sizing - is reused untouched.

     Two conventions from the collectors are load-bearing here:
       * NULL IS NOT ZERO. Null means not collected, or collected and
         rejected. Zero means the platform reported zero. A null metric is
         omitted entirely rather than rendered as 0, and a channel whose
         metrics are all null is treated as having no report at all, with the
         reason taken from `sources_failed`.
       * SEO COVERS A DIFFERENT WEEK. Search Console finalises a day about
         three days late, so its window is shifted back and recorded in
         gsc_period_start / gsc_period_end. The SEO panel is labelled with
         those, never with the row's period_start/period_end. */

  var metricWeeks = [];   /* full rows, newest first */

  /* col: source column · label: what the client sees · fmt: see fmtMetric
     snapshot: describes the account at capture time, never a weekly total -
     these must never be summed across weeks. */
  var WEEKLY_METRICS = {
    meta: {
      kpis: [
        { col: "meta_amount_spent",   label: "Amount spent",    fmt: "money" },
        { col: "meta_impressions",    label: "Impressions",     fmt: "int" },
        { col: "meta_reach",          label: "Reach",           fmt: "int" },
        { col: "meta_results",        label: "Results",         fmt: "int" },
        { col: "meta_cost_per_result",label: "Cost per result", fmt: "money2" },
        { col: "meta_ctr_all",        label: "CTR",             fmt: "percent" },
        { col: "meta_cpc_all",        label: "CPC",             fmt: "money2" },
        { col: "meta_frequency",      label: "Frequency",       fmt: "decimal" }
      ],
      cards: ["meta_amount_spent", "meta_results", "meta_impressions"],
      metrics: { spend: "meta_amount_spent", leads: "meta_results" },
      trend: [
        { col: "meta_amount_spent", label: "Spend ($)", color: "blue", fill: true },
        { col: "meta_results",      label: "Results",   color: "green" }
      ]
    },
    google_ads: {
      kpis: [
        { col: "google_cost",        label: "Cost",          fmt: "money" },
        { col: "google_clicks",      label: "Clicks",        fmt: "int" },
        { col: "google_impr",        label: "Impressions",   fmt: "int" },
        { col: "google_ctr",         label: "CTR",           fmt: "percent" },
        { col: "google_avg_cpc",     label: "Avg. CPC",      fmt: "money2" },
        { col: "google_conversions", label: "Conversions",   fmt: "decimal" },
        { col: "google_cost_conv",   label: "Cost / conv.",  fmt: "money2" },
        { col: "google_conv_rate",   label: "Conv. rate",    fmt: "percent" }
      ],
      cards: ["google_cost", "google_clicks", "google_conversions"],
      metrics: { spend: "google_cost", leads: "google_conversions", conversion_value: "google_conv_value" },
      trend: [
        { col: "google_cost",        label: "Cost ($)",    color: "blue", fill: true },
        { col: "google_conversions", label: "Conversions", color: "green" }
      ]
    },
    gbp: {
      kpis: [
        { col: "gbp_business_profile_interactions", label: "Interactions",      fmt: "int" },
        { col: "gbp_calls",          label: "Calls",              fmt: "int" },
        { col: "gbp_directions",     label: "Direction requests", fmt: "int" },
        { col: "gbp_website_clicks", label: "Website clicks",     fmt: "int" },
        { col: "gbp_views_on_search",label: "Views on search",    fmt: "int" },
        { col: "gbp_views_on_maps",  label: "Views on maps",      fmt: "int" },
        { col: "gbp_total_reviews",  label: "Total reviews",      fmt: "int",     snapshot: true },
        { col: "gbp_average_rating", label: "Average rating",     fmt: "decimal", snapshot: true }
      ],
      cards: ["gbp_calls", "gbp_directions", "gbp_website_clicks"],
      metrics: { calls: "gbp_calls" },
      trend: [
        { col: "gbp_business_profile_interactions", label: "Interactions", color: "blue", fill: true },
        { col: "gbp_calls", label: "Calls", color: "green" }
      ]
    },
    seo: {
      /* window comes from gsc_period_start/end, not period_start/end */
      window: ["gsc_period_start", "gsc_period_end"],
      kpis: [
        { col: "gsc_total_clicks",      label: "Clicks",            fmt: "int" },
        { col: "gsc_total_impressions", label: "Impressions",       fmt: "int" },
        { col: "gsc_average_ctr",       label: "Average CTR",       fmt: "percent" },
        { col: "gsc_average_position",  label: "Average position",  fmt: "position" },
        { col: "gsc_generative_ai_impressions", label: "AI impressions", fmt: "int" }
      ],
      cards: ["gsc_total_clicks", "gsc_total_impressions", "gsc_average_position"],
      metrics: {},
      trend: [
        { col: "gsc_total_clicks",      label: "Clicks",      color: "blue", fill: true },
        { col: "gsc_total_impressions", label: "Impressions", color: "green" }
      ]
    },
    organic: {
      kpis: [
        { col: "social_views",                label: "Views",             fmt: "int" },
        { col: "social_viewers",              label: "Viewers",           fmt: "int" },
        { col: "social_content_interactions", label: "Interactions",      fmt: "int" },
        { col: "social_net_follows",          label: "Net new follows",   fmt: "int" },
        { col: "social_link_clicks",          label: "Link clicks",       fmt: "int" },
        { col: "social_conversations_started",label: "Conversations",     fmt: "int" },
        { col: "social_leads",                label: "Leads",             fmt: "int" }
      ],
      cards: ["social_views", "social_content_interactions", "social_net_follows"],
      metrics: { engagements: "social_content_interactions" },
      trend: [
        { col: "social_views",                label: "Views",        color: "blue", fill: true },
        { col: "social_content_interactions", label: "Interactions", color: "green" }
      ]
    },
    website: {
      kpis: [
        { col: "ga4_active_users",     label: "Active users",    fmt: "int" },
        { col: "ga4_new_users",        label: "New users",       fmt: "int" },
        { col: "ga4_sessions",         label: "Sessions",        fmt: "int" },
        { col: "ga4_engaged_sessions", label: "Engaged sessions",fmt: "int" },
        { col: "ga4_engagement_rate",  label: "Engagement rate", fmt: "percent" },
        { col: "ga4_views",            label: "Page views",      fmt: "int" },
        { col: "ga4_key_events",       label: "Key events",      fmt: "int" },
        { col: "ga4_form_submissions", label: "Form submissions",fmt: "int" }
      ],
      cards: ["ga4_active_users", "ga4_sessions", "ga4_form_submissions"],
      metrics: {},
      trend: [
        { col: "ga4_sessions",     label: "Sessions",     color: "blue", fill: true },
        { col: "ga4_active_users", label: "Active users", color: "green" }
      ]
    }
  };

  /* Collector columns arrive as strings from PostgREST (numeric type). */
  function colNum(row, col) {
    if (!row) return null;
    var v = row[col];
    if (v === null || v === undefined || v === "") return null;   /* null is NOT zero */
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /* Which source produced this channel, for reading sources_failed. */
  var SOURCE_KEY = { meta: "meta_ads", google_ads: "google_ads", gbp: "gbp",
                     seo: "seo", organic: "social", website: "website" };

  /* Metrics where a FALL is the good news, so the chip should be green when the
     number drops. Average position is the subtle one: position 3 beats
     position 12. */
  var WEEKLY_LOWER_IS_BETTER = /(cost|cpc|cpa|cpl|cpm|position|bounce|unfollow|invalid)/i;

  /* Deltas are computed from the RAW numbers, not from the formatted value.
     Reading them back out of "3.3K" vs "4.0K" rounds -18.5% into -17.5%. */
  function weeklyDelta(k, now, before) {
    if (now === null || before === null || before === 0) return null;
    var diff = now - before;
    if (Math.abs(diff) < 1e-9) return { dir: "flat", trend: "flat", text: "no change" };

    var text;
    if (k.fmt === "percent" || k.fmt === "position" || k.fmt === "x") {
      text = (Math.round(Math.abs(diff) * 100) / 100) + (k.fmt === "percent" ? "%" : "");
    } else {
      text = (Math.round(Math.abs(diff / before) * 1000) / 10) + "%";
    }
    var trend = diff > 0 ? "up" : "down";
    var good = WEEKLY_LOWER_IS_BETTER.test(k.label) ? diff < 0 : diff > 0;
    return { dir: good ? "up" : "down", trend: trend, text: text + " vs last week" };
  }

  function weeklyPayload(platform, row, history, prevRow) {
    var def = WEEKLY_METRICS[platform];
    if (!def || !row) return null;

    var present = def.kpis.filter(function (k) { return colNum(row, k.col) !== null; });
    if (!present.length) return null;        /* nothing collected for this channel */

    var kpis = present.map(function (k) {
      var kpi = { label: k.label, value: fmtMetric(colNum(row, k.col), k.fmt) };
      /* A snapshot describes the account at capture time; comparing two
         snapshots is fine, but a backfilled week has none, so this is simply
         skipped when the previous value is missing. */
      var d = prevRow ? weeklyDelta(k, colNum(row, k.col), colNum(prevRow, k.col)) : null;
      if (d) kpi.delta = d;
      return kpi;
    });

    var cards = def.cards.map(function (c) {
      var d = null;
      for (var i = 0; i < def.kpis.length; i++) if (def.kpis[i].col === c) d = def.kpis[i];
      var v = colNum(row, c);
      return (d && v !== null) ? { label: d.label, value: fmtMetric(v, d.fmt) } : null;
    }).filter(Boolean);

    var metrics = {};
    Object.keys(def.metrics || {}).forEach(function (key) {
      var v = colNum(row, def.metrics[key]);
      if (v !== null) metrics[key] = v;
    });

    /* Trend over the weeks up to and including this one - never ahead of it,
       so an older week never shows numbers that had not happened yet. */
    var charts = [];
    var series = (def.trend || []).filter(function (t) {
      return history.some(function (h) { return colNum(h, t.col) !== null; });
    });
    if (series.length && history.length > 1) {
      charts.push({
        title: "Last " + history.length + " weeks",
        type: "line",
        labels: history.map(function (h) { return fmtDate(h.report_date); }),
        datasets: series.map(function (t) {
          return { label: t.label, color: t.color, fill: !!t.fill,
                   data: history.map(function (h) { return colNum(h, t.col); }) };
        })
      });
    }

    var tables = [{
      title: "This week in full",
      columns: [{ key: "m", label: "Metric" }, { key: "v", label: "Value", align: "num" }],
      rows: present.map(function (k) {
        return { m: k.label + (k.snapshot ? " (as at capture)" : ""),
                 v: fmtMetric(colNum(row, k.col), k.fmt) };
      })
    }];

    return { summary: { cards: cards, metrics: metrics }, kpis: kpis, charts: charts, tables: tables };
  }

  /* Why a channel has nothing this week, straight from the collector. */
  function weeklyFailureReason(row, platform) {
    if (!row || !row.sources_failed) return "";
    var key = SOURCE_KEY[platform];
    try {
      var f = typeof row.sources_failed === "string" ? JSON.parse(row.sources_failed) : row.sources_failed;
      return (f && f[key]) ? String(f[key]) : "";
    } catch (e) { return ""; }
  }

  function loadMetricWeeks() {
    if (!ctx || !ctx.clientId) { metricWeeks = []; return Promise.resolve([]); }
    return ctx.sb.from("client_weekly_metrics")
      .select("*")
      .eq("client_id", ctx.clientId)
      .order("report_date", { ascending: false })
      .limit(26)
      .then(function (r) {
        metricWeeks = (r && r.data) || [];
        return metricWeeks;
      })
      .catch(function () { metricWeeks = []; return []; });
  }

  /* ---------------- weekly report: Friday video + PDF ----------------
     One row per client per week in public.weekly_reports, kept permanently so
     a client can come back months later and watch an old one.

     Each asset is EITHER a path in the private `client-files` storage bucket
     (fetched through a short-lived signed URL) OR an external link. Both are
     supported deliberately: weekly video across every client would exhaust the
     Supabase free tier's 1 GB storage within weeks, so an external host is the
     workable option until storage is sized for it. */

  var weeklyRows = [];       /* newest first */
  var weeklySel = null;      /* week_ending of the selected row */
  var weeklySelect = document.getElementById("pl-weekly-select");

  function weekLabel(d) {
    if (!d) return "";
    var p = String(d).split("-");
    var M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return M[parseInt(p[1], 10) - 1] + " " + parseInt(p[2], 10) + ", " + p[0];
  }

  /* Known video hosts get an embed; anything else is offered as a link rather
     than guessed at, so an unexpected URL cannot render a broken black box. */
  function embedUrl(url) {
    var u = String(url || "");
    var m;
    if ((m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/))) {
      return "https://www.youtube.com/embed/" + m[1];
    }
    if ((m = u.match(/youtube\.com\/embed\/([\w-]{6,})/))) return u;
    if ((m = u.match(/loom\.com\/(?:share|embed)\/([0-9a-f]{8,})/i))) {
      return "https://www.loom.com/embed/" + m[1];
    }
    if ((m = u.match(/vimeo\.com\/(?:video\/)?(\d{6,})/))) {
      return "https://player.vimeo.com/video/" + m[1];
    }
    if ((m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/))) {
      return "https://drive.google.com/file/d/" + m[1] + "/preview";
    }
    return null;
  }

  /* Storage paths are private; a signed URL is minted per view and expires. */
  function signedUrl(path) {
    if (!path || !ctx || !ctx.sb || !ctx.sb.storage) return Promise.resolve(null);
    try {
      return ctx.sb.storage.from("client-files").createSignedUrl(path, 3600)
        .then(function (r) { return (r && r.data && r.data.signedUrl) || null; })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function renderWeeklyCurrent(row) {
    var host = document.getElementById("pl-weekly-current");
    if (!host) return;
    if (!row) { host.innerHTML = ""; return; }

    var when = weekLabel(row.week_ending);
    var title = row.title || ("Week ending " + when);
    host.innerHTML =
      '<div class="pl-panel">' +
        '<div class="pl-panel-head"><h3>' + esc(title) + "</h3>" +
        '<span class="pl-dim">' + esc(when) + "</span></div>" +
        '<div class="pl-weekly-video"></div>' +
        (row.summary ? '<p class="pl-muted" style="margin:0.25rem 0 0">' + esc(row.summary) + "</p>" : "") +
        '<div class="pl-weekly-actions"></div>' +
      "</div>";

    var videoHost = host.querySelector(".pl-weekly-video");
    var actions = host.querySelector(".pl-weekly-actions");

    /* --- video --- */
    if (row.video_url) {
      var emb = embedUrl(row.video_url);
      if (emb) {
        videoHost.innerHTML = '<div class="pl-video-wrap"><iframe src="' + esc(emb) +
          '" allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; fullscreen"' +
          ' allowfullscreen title="' + esc(title) + '"></iframe></div>';
      } else {
        actions.innerHTML += '<a class="pl-btn" href="' + esc(row.video_url) +
          '" target="_blank" rel="noopener">Watch the video →</a>';
      }
    } else if (row.video_path) {
      /* Attach the panel first, then set src. A <video> (like an <img>) that is
         given a source while detached never starts loading. */
      videoHost.innerHTML = '<div class="pl-video-wrap"><video controls preload="metadata"></video></div>';
      var vid = videoHost.querySelector("video");
      signedUrl(row.video_path).then(function (u) {
        if (u) { vid.src = u; return; }
        videoHost.innerHTML = '<p class="pl-muted" style="margin:0">This week’s video could not be loaded. ' +
          'Email <a href="mailto:contact@newlifemarketing.ca">contact@newlifemarketing.ca</a> and we’ll send it over.</p>';
      });
    }

    /* --- pdf --- */
    if (row.pdf_url) {
      actions.innerHTML += '<a class="pl-btn ghost" href="' + esc(row.pdf_url) +
        '" target="_blank" rel="noopener">Open the PDF breakdown</a>';
    } else if (row.pdf_path) {
      var a = document.createElement("a");
      a.className = "pl-btn ghost";
      a.textContent = "Open the PDF breakdown";
      a.target = "_blank"; a.rel = "noopener";
      a.href = "#";
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        a.textContent = "Opening…";
        signedUrl(row.pdf_path).then(function (u) {
          a.textContent = "Open the PDF breakdown";
          if (u) window.open(u, "_blank", "noopener");
          else alert("That PDF could not be opened. Please email contact@newlifemarketing.ca.");
        });
      });
      actions.appendChild(a);
    }

    if (!row.video_url && !row.video_path && !row.pdf_url && !row.pdf_path) {
      videoHost.innerHTML = '<p class="pl-muted" style="margin:0">This week’s report is being prepared.</p>';
    }
  }

  function renderWeeklyArchive() {
    var host = document.getElementById("pl-weekly-archive");
    if (!host) return;
    if (weeklyRows.length < 2) { host.innerHTML = ""; return; }
    host.innerHTML =
      '<div class="pl-panel"><div class="pl-panel-head"><h3>Past weekly reports</h3>' +
      '<span class="pl-dim">' + weeklyRows.length + " in total</span></div>" +
      '<div class="pl-archive-list"></div></div>';
    var list = host.querySelector(".pl-archive-list");
    weeklyRows.forEach(function (r) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pl-archive-row" + (r.week_ending === weeklySel ? " on" : "");
      var tags = [];
      if (r.video_url || r.video_path) tags.push('<span class="pl-tag on">Video</span>');
      if (r.pdf_url || r.pdf_path) tags.push('<span class="pl-tag on">PDF</span>');
      b.innerHTML =
        "<span><span class=\"pl-archive-when\">" + esc(weekLabel(r.week_ending)) + "</span>" +
        (r.title ? '<span class="pl-archive-meta"> · ' + esc(r.title) + "</span>" : "") + "</span>" +
        '<span class="pl-archive-tags">' + (tags.join("") || '<span class="pl-tag">Being prepared</span>') + "</span>";
      b.addEventListener("click", function () { selectWeek(r.week_ending); });
      list.appendChild(b);
    });
  }

  function selectWeek(weekEnding) {
    weeklySel = weekEnding;
    var row = null;
    for (var i = 0; i < weeklyRows.length; i++) {
      if (weeklyRows[i].week_ending === weekEnding) { row = weeklyRows[i]; break; }
    }
    if (weeklySelect) weeklySelect.value = weekEnding || "";
    renderWeeklyCurrent(row);
    renderWeeklyArchive();
  }

  function renderWeekly() {
    var emptyHost = document.querySelector('[data-empty="weekly"]');
    var sub = document.getElementById("pl-weekly-sub");
    if (emptyHost) { emptyHost.hidden = true; emptyHost.innerHTML = ""; }

    if (!weeklyRows.length) {
      if (weeklySelect) weeklySelect.hidden = true;
      document.getElementById("pl-weekly-current").innerHTML = "";
      document.getElementById("pl-weekly-archive").innerHTML = "";
      if (sub) sub.textContent = "A short video walkthrough and a written breakdown, published every Friday.";
      emptyState("weekly", "weekly");
      return;
    }
    if (weeklySelect) {
      weeklySelect.hidden = false;
      weeklySelect.innerHTML = weeklyRows.map(function (r) {
        return '<option value="' + esc(r.week_ending) + '">' + esc(weekLabel(r.week_ending)) + "</option>";
      }).join("");
    }
    if (sub) {
      sub.textContent = weeklyRows.length === 1
        ? "Your weekly video walkthrough and written breakdown."
        : "Every Friday’s video and written breakdown. " + weeklyRows.length + " weeks available.";
    }
    selectWeek(weeklySel || weeklyRows[0].week_ending);
  }

  function loadWeekly() {
    if (!ctx || !ctx.clientId) { weeklyRows = []; renderWeekly(); return Promise.resolve(); }
    return ctx.sb.from("weekly_reports")
      .select("week_ending, title, summary, video_path, video_url, pdf_path, pdf_url, published_at")
      .eq("client_id", ctx.clientId)
      .order("week_ending", { ascending: false })
      .then(function (r) {
        weeklyRows = (r.data || []);
        weeklySel = null;
        renderWeekly();
      })
      .catch(function () { weeklyRows = []; renderWeekly(); });
  }

  if (weeklySelect) weeklySelect.addEventListener("change", function () {
    selectWeek(weeklySelect.value);
  });

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
        /* NOTE: if Chart.js ever locks a canvas at 0x0 (it writes the measured
           size inline), resize() cannot recover it — not by clearing the
           inline style, and not with explicit dimensions. Both were tried and
           neither works; only destroying and recreating the chart does. That
           state needs a window with no width at construction, which a real
           browser tab does not have, so it is left unhandled rather than
           carrying machinery that would never run in production. */
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
    if (dirtyChannels[view]) { dirtyChannels[view] = false; renderChannelWhenVisible(view); }
    else resizeChartsIn(view);
    if (periodSel) periodSel.hidden = (view === "onboarding") || (view === "weekly") || !periods.length;
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
    /* The weekly collectors are the system going forward. When they have rows
       for this client, those weeks ARE the periods. report_cache (the older
       monthly backfill) is only consulted when there are none, so a client
       with history but no collector runs yet still sees something. */
    if (metricWeeks.length) {
      periods = metricWeeks.map(function (r) {
        return { start: r.period_start, end: r.period_end, week: r.report_date,
                 label: fmtRange(r.period_start, r.period_end) };
      });
      if (periodSel) {
        periodSel.innerHTML = periods.map(function (pp, i) {
          return '<option value="' + i + '">' + esc(pp.label) + "</option>";
        }).join("");
        periodSel.hidden = !periods.length || currentView === "onboarding" || currentView === "weekly";
      }
      return Promise.resolve(periods);
    }
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
          periodSel.hidden = !out.length || currentView === "onboarding" || currentView === "weekly";
        }
        return out;
      });
  }
  function fetchPeriod(p) {
    return ctx.sb.from("report_cache")
      .select("platform, period_start, period_end, payload, is_sample, refreshed_at")
      .eq("client_id", ctx.clientId)   /* see loadPeriods — admins can read every client */
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

    /* A period that came from the collectors is built from the row we already
       hold - no extra round trip, and the previous week is right there too. */
    if (p.week) {
      var at = -1;
      for (var k = 0; k < metricWeeks.length; k++) {
        if (metricWeeks[k].report_date === p.week) { at = k; break; }
      }
      if (at !== -1) {
        var row = metricWeeks[at];
        var prevRow = metricWeeks[at + 1] || null;
        /* Oldest-first, ending at the selected week. */
        var history = metricWeeks.slice(at, at + 8).slice().reverse();
        var prevHistory = prevRow ? metricWeeks.slice(at + 1, at + 9).slice().reverse() : [];

        Object.keys(WEEKLY_METRICS).forEach(function (platform) {
          if (!hasSection(platform)) return;
          var def = WEEKLY_METRICS[platform];
          var win = def.window || ["period_start", "period_end"];
          var payload = weeklyPayload(platform, row, history, prevRow);
          if (payload) {
            reports[platform] = {
              platform: platform,
              period_start: row[win[0]] || row.period_start,
              period_end: row[win[1]] || row.period_end,
              payload: payload, is_sample: false,
              report_date: row.report_date,
              refreshed_at: null
            };
          }
          var prevPayload = prevRow ? weeklyPayload(platform, prevRow, prevHistory, metricWeeks[at + 2] || null) : null;
          if (prevPayload) {
            prevReports[platform] = {
              platform: platform, payload: prevPayload,
              period_start: prevRow[win[0]] || prevRow.period_start,
              period_end: prevRow[win[1]] || prevRow.period_end
            };
          }
        });
        /* Consecutive collector weeks are always the same length, so a
           week-over-week delta is always a fair comparison. */
        prevComparable = !!prevRow;
        weeklyRowForNotes = row;
        renderAll();
        return Promise.resolve();
      }
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
    if (!ctx.clientId) { showView(start); renderAll(); renderWeekly(); return; }
    /* The weekly archive is independent of the reporting periods, so it loads
       in parallel rather than waiting on them. */
    loadWeekly();
    loadMetricWeeks().then(function () {
      return loadPeriods();
    }).then(function (list) {
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
