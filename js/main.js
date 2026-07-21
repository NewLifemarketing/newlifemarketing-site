/* NewLife Marketing — shared behavior */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Mobile nav ---------- */
  var toggle = document.querySelector(".nav-toggle");
  var closeBtn = document.querySelector(".nav-close");
  if (toggle) {
    toggle.addEventListener("click", function () {
      document.body.classList.add("nav-open");
      toggle.setAttribute("aria-expanded", "true");
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      document.body.classList.remove("nav-open");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    });
  }

  /* ---------- Mega menu (click on mobile/keyboard, hover on desktop) ---------- */
  var items = document.querySelectorAll(".nav-item.has-mega");
  items.forEach(function (item) {
    var btn = item.querySelector("button.top");
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var wasOpen = item.classList.contains("open");
      items.forEach(function (i) { i.classList.remove("open"); });
      if (!wasOpen) item.classList.add("open");
      btn.setAttribute("aria-expanded", String(!wasOpen));
    });
    item.addEventListener("mouseenter", function () {
      if (window.matchMedia("(min-width: 1281px)").matches) item.classList.add("open");
    });
    item.addEventListener("mouseleave", function () {
      if (window.matchMedia("(min-width: 1281px)").matches) item.classList.remove("open");
    });
  });
  document.addEventListener("click", function () {
    items.forEach(function (i) { i.classList.remove("open"); });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      items.forEach(function (i) { i.classList.remove("open"); });
      document.body.classList.remove("nav-open");
      closeOverlays();
    }
  });

  /* ---------- Scroll reveal ---------- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- Animated counters (numeric stats only) ---------- */
  function animateCounter(el) {
    var raw = el.getAttribute("data-count");
    var target = parseFloat(raw);
    if (isNaN(target) || reduceMotion) return;
    var prefix = el.getAttribute("data-prefix") || "";
    var suffix = el.getAttribute("data-suffix") || "";
    var start = null;
    var dur = 1400;
    function tick(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = Math.round(target * eased);
      el.textContent = prefix + val.toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  var counters = document.querySelectorAll("[data-count]");
  if ("IntersectionObserver" in window) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { animateCounter(en.target); cio.unobserve(en.target); }
      });
    }, { threshold: 0.5 });
    counters.forEach(function (el) { cio.observe(el); });
  }

  /* ---------- Overlays (lightbox + quiz) ---------- */
  function closeOverlays() {
    document.querySelectorAll(".overlay.open").forEach(function (o) { o.classList.remove("open"); });
    document.querySelectorAll(".overlay video.lb-player").forEach(function (v) { v.pause(); v.remove(); });
  }
  document.querySelectorAll(".overlay").forEach(function (ov) {
    ov.addEventListener("click", function (e) { if (e.target === ov) closeOverlays(); });
    var x = ov.querySelector(".close-x");
    if (x) x.addEventListener("click", closeOverlays);
  });

  /* Lightbox: any .loop-thumb opens it */
  var lightbox = document.getElementById("lightbox");
  document.querySelectorAll(".loop-thumb[data-lightbox]").forEach(function (t) {
    t.setAttribute("role", "button");
    t.setAttribute("tabindex", "0");
    function open() {
      if (!lightbox) return;
      var title = lightbox.querySelector(".lb-title");
      var body = lightbox.querySelector(".loop-thumb");
      var needs = lightbox.querySelector(".lb-needs");
      var src = t.getAttribute("data-video");
      if (title) title.textContent = t.getAttribute("data-title") || "Video";
      /* Real file: swap the placeholder for a playing <video>; else show the NEEDS chip */
      var old = lightbox.querySelector("video.lb-player");
      if (old) old.remove();
      if (src) {
        if (body) body.style.display = "none";
        var v = document.createElement("video");
        v.className = "lb-player";
        v.src = src;
        v.controls = true;
        v.autoplay = true;
        v.playsInline = true;
        lightbox.querySelector(".modal").appendChild(v);
      } else {
        if (body) body.style.display = "";
        if (needs) needs.textContent = "[NEEDS: " + (t.getAttribute("data-needs") || "final video file") + "]";
      }
      lightbox.classList.add("open");
    }
    t.addEventListener("click", open);
    t.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });

  /* ---------- Ballpark quiz ---------- */
  var quiz = document.getElementById("quiz");
  var quizState = { service: "", budget: "" };
  document.querySelectorAll("[data-open-quiz]").forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.preventDefault();
      if (quiz) {
        quiz.classList.add("open");
        showQuizStep(1);
      }
    });
  });
  function showQuizStep(n) {
    if (!quiz) return;
    quiz.querySelectorAll(".quiz-step").forEach(function (s) {
      s.classList.toggle("active", s.getAttribute("data-step") === String(n));
    });
  }
  if (quiz) {
    quiz.querySelectorAll("[data-quiz-service]").forEach(function (b) {
      b.addEventListener("click", function () {
        quizState.service = b.getAttribute("data-quiz-service");
        showQuizStep(2);
      });
    });
    quiz.querySelectorAll("[data-quiz-budget]").forEach(function (b) {
      b.addEventListener("click", function () {
        quizState.budget = b.getAttribute("data-quiz-budget");
        showQuizStep(3);
      });
    });
    var qform = quiz.querySelector("form");
    if (qform) {
      qform.addEventListener("submit", function (e) {
        e.preventDefault();
        /* [NEEDS: GoHighLevel form/webhook endpoint — quiz submissions are not stored yet] */
        var params = new URLSearchParams({
          service: quizState.service,
          budget: quizState.budget,
          name: qform.querySelector("[name=name]").value,
          email: qform.querySelector("[name=email]").value
        });
        window.location.href = "/book/?" + params.toString();
      });
    }
  }

  /* ---------- Booking form → calendar page ---------- */
  var bookForm = document.getElementById("book-form");
  if (bookForm) {
    var qs = new URLSearchParams(window.location.search);
    ["service", "budget", "name", "email"].forEach(function (k) {
      var f = bookForm.querySelector("[name=" + k + "]");
      if (f && qs.get(k)) f.value = qs.get(k);
    });
    bookForm.addEventListener("submit", function (e) {
      e.preventDefault();
      /* [NEEDS: GoHighLevel form endpoint — submissions currently route straight to the calendar page] */
      window.location.href = "/book/call/";
    });
  }

  /* ---------- Filter chips ---------- */
  document.querySelectorAll("[data-filter-group]").forEach(function (group) {
    var chips = group.querySelectorAll(".chip");
    var targetSel = group.getAttribute("data-filter-target");
    var cards = document.querySelectorAll(targetSel);
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (c) { c.classList.remove("active"); });
        chip.classList.add("active");
        var val = chip.getAttribute("data-filter");
        cards.forEach(function (card) {
          var tags = (card.getAttribute("data-tags") || "").split(" ");
          card.style.display = (val === "all" || tags.indexOf(val) !== -1) ? "" : "none";
        });
      });
    });
  });

  /* ---------- Newsletter (placeholder) ---------- */
  document.querySelectorAll(".newsletter").forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      /* [NEEDS: newsletter/email platform signup endpoint] */
      f.innerHTML = '<p class="small" style="margin:0">Thanks — you’re on the list once the email platform is connected.</p>';
    });
  });

  /* ---------- Hero video: honour prefers-reduced-motion (poster stays) ---------- */
  if (reduceMotion) {
    document.querySelectorAll("video.hero-video").forEach(function (v) {
      v.removeAttribute("autoplay");
      v.pause();
    });
  }
})();
