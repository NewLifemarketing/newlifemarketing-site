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
    var BOOK_WEBHOOK = "https://services.leadconnectorhq.com/hooks/RFnM9KZ3YGnxyFfaekIT/webhook-trigger/f80b5b72-62d8-4ff9-b527-d8bd2de826a8";
    var bookMsg = document.getElementById("book-msg");
    function showBookMsg(text, ok) {
      if (!bookMsg) return;
      bookMsg.textContent = text;
      bookMsg.style.display = "block";
      bookMsg.style.color = ok ? "var(--blue)" : "#C0392B";
      bookMsg.style.fontWeight = "600";
    }
    bookForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var hp = bookForm.querySelector("[name=website_confirm]");
      if (hp && hp.value) return; /* honeypot filled -> silent abort */
      var g = function (n) {
        var f = bookForm.querySelector("[name=" + n + "]");
        return f ? f.value.trim() : "";
      };
      var full = g("name");
      var sp = full.indexOf(" ");
      var payload = {
        first_name: sp === -1 ? full : full.slice(0, sp),
        last_name: sp === -1 ? "" : full.slice(sp + 1),
        full_name: full,
        email: g("email"),
        phone: g("phone"),
        business_name: g("business"),
        website_url: g("website"),
        service_interest: g("service"),
        budget_range: g("budget"),
        primary_goal: g("goal"),
        source: "newlife_strategy_call_form"
      };
      var btn = bookForm.querySelector("button[type=submit]");
      if (btn) btn.disabled = true;
      fetch(BOOK_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        showBookMsg("✓ Got it — taking you to pick your call time…", true);
        bookForm.reset();
        setTimeout(function () { window.location.href = "/book/call/"; }, 1200);
      }).catch(function () {
        showBookMsg("Something went wrong sending your info — please try again, or call 705-302-1097.", false);
        if (btn) btn.disabled = false;
      });
    });
  }

  /* ---------- Contact form -> GoHighLevel webhook (separate from book-form) ---------- */
  var contactForm = document.getElementById("contact-form");
  if (contactForm) {
    var CONTACT_WEBHOOK = "https://services.leadconnectorhq.com/hooks/RFnM9KZ3YGnxyFfaekIT/webhook-trigger/d1d8da26-2d8a-4501-98e4-30656ae0dec2";
    var contactMsg = document.getElementById("contact-msg");
    function showContactMsg(text, ok) {
      if (!contactMsg) return;
      contactMsg.textContent = text;
      contactMsg.style.display = "block";
      contactMsg.style.color = ok ? "var(--blue)" : "#C0392B";
      contactMsg.style.fontWeight = "600";
    }
    contactForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var hp = contactForm.querySelector("[name=website_confirm]");
      if (hp && hp.value) return; /* honeypot filled -> silent abort */
      var g = function (n) {
        var f = contactForm.querySelector("[name=" + n + "]");
        return f ? f.value.trim() : "";
      };
      var payload = {
        first_name: g("first_name"),
        last_name: g("last_name"),
        full_name: (g("first_name") + " " + g("last_name")).trim(),
        email: g("email"),
        phone: g("phone"),
        message: g("message"),
        source: "newlife_contact_form"
      };
      var btn = contactForm.querySelector("button[type=submit]");
      if (btn) btn.disabled = true;
      fetch(CONTACT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        showContactMsg("✓ Message sent — we'll get back to you within one business day.", true);
        contactForm.reset();
        if (btn) btn.disabled = false;
      }).catch(function () {
        showContactMsg("Something went wrong sending your message — please try again, or email contact@newlifemarketing.ca.", false);
        if (btn) btn.disabled = false;
      });
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
