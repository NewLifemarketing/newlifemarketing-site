/* NewLife Client Portal — Phase 1 UI behavior (sample data only). */
(function () {
  "use strict";

  var app = document.getElementById("pl-app");
  var titleEl = document.getElementById("pl-view-title");
  var dateRange = document.getElementById("pl-daterange");
  var TITLES = {
    onboarding: "Onboarding",
    meta: "Meta Ads",
    google: "Google Ads",
    gbp: "Google Business Profile"
  };
  // Reporting views show the date-range selector; onboarding does not.
  var REPORTING = { meta: 1, google: 1, gbp: 1 };
  var charted = {};

  /* ---------- Sidebar navigation ---------- */
  function showView(view) {
    document.querySelectorAll(".pl-nav-item[data-view]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === view);
    });
    document.querySelectorAll(".pl-view").forEach(function (v) {
      v.classList.toggle("active", v.getAttribute("data-view") === view);
    });
    if (titleEl) titleEl.textContent = TITLES[view] || "Dashboard";
    if (dateRange) dateRange.hidden = !REPORTING[view];
    if (REPORTING[view]) initCharts(view);
    app.classList.remove("nav-open");
    window.scrollTo(0, 0);
  }

  document.querySelectorAll(".pl-nav-item[data-view]").forEach(function (b) {
    b.addEventListener("click", function () { showView(b.getAttribute("data-view")); });
  });

  /* ---------- Mobile sidebar ---------- */
  document.querySelectorAll("[data-open-nav]").forEach(function (b) {
    b.addEventListener("click", function () { app.classList.add("nav-open"); });
  });
  document.querySelectorAll("[data-close-nav]").forEach(function (b) {
    b.addEventListener("click", function () { app.classList.remove("nav-open"); });
  });

  /* ---------- Logout (Phase 1: just returns to login) ---------- */
  var logout = document.getElementById("pl-logout");
  if (logout) logout.addEventListener("click", function () { /* Phase 2: clear session */ });

  /* ---------- Sample document downloads ---------- */
  document.querySelectorAll("[data-sample-dl]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      alert("Sample document. Real files will be attached per client in Phase 2.");
    });
  });

  /* ---------- Upload area (Phase 1: visual only, no real upload) ---------- */
  var drop = document.getElementById("pl-drop");
  var fileInput = document.getElementById("pl-fileinput");
  var uploaded = document.getElementById("pl-uploaded");
  function addFiles(files) {
    Array.prototype.forEach.call(files, function (f) {
      var li = document.createElement("li");
      var kb = f.size ? " · " + Math.max(1, Math.round(f.size / 1024)) + " KB" : "";
      li.innerHTML = '<span class="ok">✓</span> <span>' + escapeHtml(f.name) + kb +
        ' <span class="pl-dim">(queued — upload activates in Phase 2)</span></span>';
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
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Charts (Chart.js, sample data) ---------- */
  var GRID = "rgba(42,42,56,0.9)", TICK = "#7E7E8F", BLUE = "#2196F3", BLUE2 = "#4DABF5", GREEN = "#33C481";
  function baseOpts(extra) {
    var o = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#B7B7C4", boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 11 } } },
        y: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 11 } }, beginAtZero: true }
      }
    };
    return Object.assign(o, extra || {});
  }
  var DAYS = ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6"];

  var BUILDERS = {
    meta: function () {
      new Chart(document.getElementById("chart-meta-trend"), {
        type: "line",
        data: { labels: DAYS, datasets: [
          { label: "Spend ($)", data: [520, 610, 700, 760, 900, 1090], borderColor: BLUE, backgroundColor: "rgba(33,150,243,0.14)", fill: true, tension: 0.35, borderWidth: 2 },
          { label: "Conversions", data: [420, 560, 620, 700, 820, 980], borderColor: GREEN, tension: 0.35, borderWidth: 2 }
        ] }, options: baseOpts()
      });
      new Chart(document.getElementById("chart-meta-donut"), {
        type: "doughnut",
        data: { labels: ["Prospecting", "Retargeting", "Advantage+", "Interests"],
          datasets: [{ data: [3120, 1840, 2210, 1250], backgroundColor: [BLUE, BLUE2, GREEN, "#5c5c70"], borderColor: "#16161F", borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "bottom", labels: { color: "#B7B7C4", boxWidth: 12, font: { size: 11 } } } } }
      });
    },
    google: function () {
      new Chart(document.getElementById("chart-google-trend"), {
        type: "line",
        data: { labels: DAYS, datasets: [
          { label: "Conversions", data: [38, 46, 52, 61, 70, 82], borderColor: BLUE, backgroundColor: "rgba(33,150,243,0.14)", fill: true, tension: 0.35, borderWidth: 2 }
        ] }, options: baseOpts()
      });
      new Chart(document.getElementById("chart-google-bar"), {
        type: "bar",
        data: { labels: ["Search-Brand", "Search-NB", "PMax", "YouTube"],
          datasets: [{ label: "Cost ($)", data: [410, 2140, 1480, 530], backgroundColor: [BLUE, BLUE, BLUE2, "#5c5c70"], borderRadius: 6 }] },
        options: baseOpts({ plugins: { legend: { display: false } } })
      });
    },
    gbp: function () {
      new Chart(document.getElementById("chart-gbp-trend"), {
        type: "line",
        data: { labels: DAYS, datasets: [
          { label: "Calls", data: [28, 34, 39, 41, 47, 51], borderColor: BLUE, tension: 0.35, borderWidth: 2 },
          { label: "Directions", data: [60, 72, 78, 84, 96, 110], borderColor: GREEN, backgroundColor: "rgba(51,196,129,0.12)", fill: true, tension: 0.35, borderWidth: 2 }
        ] }, options: baseOpts()
      });
      new Chart(document.getElementById("chart-gbp-donut"), {
        type: "doughnut",
        data: { labels: ["Search — Discovery", "Search — Direct", "Maps"],
          datasets: [{ data: [58, 27, 15], backgroundColor: [BLUE, BLUE2, GREEN], borderColor: "#16161F", borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "bottom", labels: { color: "#B7B7C4", boxWidth: 12, font: { size: 11 } } } } }
      });
    }
  };

  function initCharts(view) {
    if (charted[view] || typeof Chart === "undefined" || !BUILDERS[view]) return;
    charted[view] = true;
    BUILDERS[view]();
  }

  /* ---------- Date range (Phase 1: cosmetic; Phase 2 refetches) ---------- */
  if (dateRange) dateRange.addEventListener("change", function () {
    /* Phase 2: refetch the active view's data for the selected range. */
  });
})();
