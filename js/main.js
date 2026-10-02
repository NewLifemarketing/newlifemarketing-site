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

  /* ---------- Mega menu ----------
     Desktop: one card that travels. All six panels share a single piece of
     chrome, so moving along the menu bar morphs that card's position and size
     and slides the tail to the new trigger, rather than closing one dropdown
     and opening another. Mobile keeps the accordion. */
  var items = document.querySelectorAll(".nav-item.has-mega");
  var navEl = document.querySelector(".nav");
  var card = document.querySelector(".nav-card");
  var tail = document.querySelector(".nav-tail");
  var header = document.querySelector(".site-header");
  var panels = [].slice.call(document.querySelectorAll(".nav-item.has-mega .mega"));
  var desktop = function () { return window.matchMedia("(min-width: 1281px)").matches; };
  var EDGE = 16;          /* keep the card this far off either viewport edge */

  /* Opt in to the travelling layout only once the script is live. Without
     this class the CSS leaves the original per-item dropdowns in place, so a
     blocked or broken script degrades to the old menu instead of no menu. */
  if (navEl && card && tail) navEl.classList.add("nav-travel");

  var current = null;     /* the open .nav-item, or null */

  function place(item, animate) {
    if (!desktop() || !card || !tail || !header) return;
    var mega = item.querySelector(".mega");
    var btn = item.querySelector(".top");
    if (!mega || !btn) return;

    /* Measure the panel at its natural size. It is absolutely positioned and
       only hidden by opacity/visibility, so it already has layout — no
       offscreen clone needed. */
    var hb = header.getBoundingClientRect();
    var pw = mega.offsetWidth;
    var ph = mega.offsetHeight;

    /* Centre under the trigger, then pull back inside the viewport. */
    var br = btn.getBoundingClientRect();
    var centre = br.left + br.width / 2;
    var x = centre - pw / 2;
    if (x + pw > window.innerWidth - EDGE) x = window.innerWidth - EDGE - pw;
    if (x < EDGE) x = EDGE;
    x = Math.round(x - hb.left);               /* header-relative */

    var tx = Math.round(centre - hb.left);     /* tail tracks the trigger, not the card */

    /* Every panel is moved, not just the active one. They all share the
       card's coordinate space, so keeping them in lockstep means the
       incoming panel is already under the card when it fades up — otherwise
       it would appear at the destination while the card was still in
       transit, and the content would detach from its own background. */
    function apply() {
      card.style.transform = "translateX(" + x + "px)";
      card.style.width = pw + "px";
      card.style.height = ph + "px";
      tail.style.transform = "translateX(" + tx + "px)";
      panels.forEach(function (m) { m.style.transform = "translateX(" + x + "px)"; });
    }

    if (animate) { apply(); return; }
    /* First open: jump into place with no transition, so the card does not
       fly across the header from wherever it was last left. */
    var moving = [card, tail].concat(panels);
    var saved = moving.map(function (el) { return el.style.transition; });
    moving.forEach(function (el) { el.style.transition = "none"; });
    apply();
    void card.offsetWidth;                     /* flush, then restore */
    moving.forEach(function (el, i) { el.style.transition = saved[i]; });
  }

  function openItem(item) {
    if (!desktop()) return;
    var animate = current !== null;            /* already open = travel, else appear */
    items.forEach(function (i) {
      if (i === item) return;
      i.classList.remove("open");
      var m = i.querySelector(".mega");
      if (m) m.classList.remove("panel-on");
      var b = i.querySelector("button.top");
      if (b) b.setAttribute("aria-expanded", "false");
    });
    item.classList.add("open");
    var btn = item.querySelector("button.top");
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (navEl) navEl.classList.add("menu-open");
    place(item, animate);
    var mega = item.querySelector(".mega");
    if (mega) mega.classList.add("panel-on");
    current = item;
  }

  function closeAll() {
    items.forEach(function (i) {
      i.classList.remove("open");
      var m = i.querySelector(".mega");
      if (m) m.classList.remove("panel-on");
      var b = i.querySelector("button.top");
      if (b) b.setAttribute("aria-expanded", "false");
    });
    if (navEl) navEl.classList.remove("menu-open");
    current = null;
  }

  var closeTimer = null;
  function cancelClose() { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } }
  function scheduleClose() {
    cancelClose();
    /* Closing on a bare mouseleave made the menu impossible to use: moving
       diagonally toward a link clips outside the item for a frame and the
       panel vanished mid-click. Opening is instant; closing waits. */
    closeTimer = setTimeout(closeAll, 260);
  }

  items.forEach(function (item) {
    var btn = item.querySelector("button.top");
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var wasOpen = item.classList.contains("open");
      if (wasOpen) { closeAll(); return; }
      if (!desktop()) {
        /* mobile accordion: no travelling card, just toggle in place */
        items.forEach(function (i) {
          i.classList.remove("open");
          var b = i.querySelector("button.top");
          if (b) b.setAttribute("aria-expanded", "false");
        });
        item.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
        return;
      }
      openItem(item);
    });
    item.addEventListener("mouseenter", function () {
      if (!desktop()) return;
      cancelClose();
      openItem(item);
    });
    item.addEventListener("mouseleave", function () {
      if (!desktop()) return;
      scheduleClose();
    });
    item.addEventListener("focusin", function (e) {
      /* Only keyboard focus should open the menu. A mouse click on the
         trigger fires focusin BEFORE click, so this handler would open the
         panel and the click handler would then see it as already open and
         close it again — the menu did nothing at all on tap. :focus-visible
         is false for pointer focus, which is exactly the distinction. */
      if (e.target === btn && !btn.matches(":focus-visible")) return;
      cancelClose();
      if (desktop()) openItem(item);
      else item.classList.add("open");
    });
  });

  /* The card sits below the triggers, so the pointer leaves the .nav-item on
     the way down to it. Keeping the menu alive while the pointer is over the
     card itself is what makes the panel reachable. */
  [card, tail].forEach(function (el) {
    if (!el) return;
    el.addEventListener("mouseenter", cancelClose);
    el.addEventListener("mouseleave", scheduleClose);
  });

  window.addEventListener("resize", function () {
    if (!desktop()) { closeAll(); return; }
    if (current) place(current, false);
  });
  document.addEventListener("click", function () { closeAll(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeAll();
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
        /* Analytics only. Wrapped so a listener throwing can never reach the
           .catch() below and tell someone their lead failed when it landed —
           they would resubmit (duplicate) or give up (lost lead). Tracking
           must never be able to break lead capture. */
        try {
          document.dispatchEvent(new CustomEvent("nl:form-success", { detail: { form: "book" } }));
          /* GA4 conversion. Fires off the SAME confirmed-webhook signal as the
             PostHog event, so the two can never disagree about what counts as
             a lead. Until this existed GA4 recorded zero key events, which
             meant it could not attribute a single booking to a page, campaign
             or channel. */
          if (typeof gtag === "function") {
            gtag("event", "generate_lead", { form: "book", value: 0, currency: "CAD" });
          }
        } catch (err) {}
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
        try {
          document.dispatchEvent(new CustomEvent("nl:form-success", { detail: { form: "contact" } }));
          if (typeof gtag === "function") {
            gtag("event", "generate_lead", { form: "contact", value: 0, currency: "CAD" });
          }
        } catch (err) {}
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
