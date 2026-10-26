/* NewLife Marketing — visitor identity + behaviour tracking.

   Answers three questions the site could not answer before:
     1. Who is on the site right now (when we can know)
     2. What did they read, in what order, for how long
     3. Have they been here before

   The identity half deliberately does NOT depend on GoHighLevel's cookie
   internals. It reads a contact id off the URL, which we control, and keeps
   it in localStorage. That works for GHL trigger links AND for the Outlook
   outreach pipeline, and it does not silently break when a vendor changes
   their script. */
(function () {
  "use strict";

  /* ---------- Config ---------- */

  /* PostHog project 616277, US Cloud. This is the public project token —
     PostHog labels it "write-only key for use in client libraries, safe to use
     in public apps". Same class as the GA4 ID already in this repo. */
  var POSTHOG_KEY = "phc_z3eC3QvX6FpqDzrX26DVAw6b5NNQy2iUgBSsAnVmGcv2";
  var POSTHOG_HOST = "https://us.i.posthog.com";

  /* Query params that carry a GHL contact id into the site. `nl_cid` is ours;
     `contact_id` is what GHL's own merge field produces. Either works. */
  var ID_PARAMS = ["nl_cid", "contact_id"];
  var STORE_KEY = "nl_contact_id";

  /* ---------- Identity capture ----------
     This runs BEFORE the key guard on purpose. Reading the contact id,
     remembering it, and getting it back out of the address bar all have to
     happen even when analytics is switched off — otherwise a trigger-link
     click leaves "?nl_cid=..." sitting in the visitor's address bar, visible
     in screenshots and in anything they paste to a colleague.

     Only the PostHog calls depend on the key, and those stay below the guard. */

  function readIdFromUrl() {
    var params = new URLSearchParams(window.location.search);
    for (var i = 0; i < ID_PARAMS.length; i++) {
      var v = params.get(ID_PARAMS[i]);
      /* GHL merge fields that fail to resolve arrive literally, e.g.
         "{{contact.id}}". Treat those as absent rather than identifying a
         hundred different people as the same broken string. */
      if (v && v.indexOf("{{") === -1) return v;
    }
    return null;
  }

  function store(id) {
    try { window.localStorage.setItem(STORE_KEY, id); } catch (e) {}
  }

  function recall() {
    try { return window.localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }

  /* Strip the id from the address bar once read. Keeps it out of shared
     links, screenshots, and the referrer we send to third parties. Leaves
     utm_ and every other param untouched. */
  function scrubUrl() {
    if (!window.history || !window.history.replaceState) return;
    var url = new URL(window.location.href);
    var touched = false;
    ID_PARAMS.concat([INTERNAL_KEY]).forEach(function (p) {
      if (url.searchParams.has(p)) { url.searchParams.delete(p); touched = true; }
    });
    if (touched) window.history.replaceState({}, document.title, url.toString());
  }

  /* ---------- Internal flag ----------

     Our own phones and laptops must not count as leads or as visitors.

       ?nl_internal=<label>   (e.g. keegan-iphone) sets the flag on this browser, remembers the
                              label, and strips the parameter from the address bar.
       ?nl_internal=0         clears it again.

     Setting it ALSO deletes the stored contact id and resets PostHog. A browser that once
     clicked a lead's link keeps that lead's id and is counted as them on every later visit,
     which is exactly what our own phones were doing.

     While it is set: any nl_cid / contact_id in the URL is ignored, identify() is never called,
     and every event carries nl_internal:true and nl_internal_label as super-properties.
     To test a lead's link, add &nl_internal=1 to it. */

  var INTERNAL_KEY = "nl_internal";
  var internalParam = new URLSearchParams(window.location.search).get(INTERNAL_KEY);
  var internalLabel = null;      /* the label while flagged, else null */
  var internalChanged = null;    /* "set" | "cleared" when this page view changed the flag */

  function recallInternal() {
    try { return window.localStorage.getItem(INTERNAL_KEY); } catch (e) { return null; }
  }
  function storeInternal(v) {
    try {
      if (v === null) window.localStorage.removeItem(INTERNAL_KEY);
      else window.localStorage.setItem(INTERNAL_KEY, v);
    } catch (e) {}
  }
  function forgetContact() {
    try { window.localStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  if (internalParam !== null) {
    if (internalParam === "0") {
      storeInternal(null);
      internalChanged = "cleared";
    } else {
      internalLabel = internalParam.trim().slice(0, 64) || "internal";
      storeInternal(internalLabel);
      forgetContact();
      internalChanged = "set";
    }
  } else {
    internalLabel = recallInternal() || null;
  }

  var fromUrl = internalLabel ? null : readIdFromUrl();
  var contactId = internalLabel ? null : (fromUrl || recall());
  if (fromUrl) store(contactId);

  /* Scrub whether or not the id turned out to be usable. An unresolved merge
     field is precisely the case where a prospect would otherwise sit looking
     at "?nl_cid={{contact.id}}". No-ops when there was no id param at all.
     Reads window.location.pathname below are unaffected — replaceState only
     rewrites the query string. */
  scrubUrl();

  if (!POSTHOG_KEY) return;

  /* ---------- PostHog loader ---------- */
  /* Vendor snippet, kept verbatim so it can be diffed against theirs on
     upgrade. It defines window.posthog and queues calls made before load. */
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    /* Time-on-page comes from pairing $pageview with $pageleave. Without
       this, a visit shows pages read but no dwell time on the last one. */
    capture_pageleave: true,
    capture_pageview: true,
    /* Don't create a stored profile for anonymous traffic until there is a
       reason to. Identified visitors get one the moment they identify. */
    person_profiles: "identified_only"
  });

  /* Internal flag, PostHog side. reset() first (it also wipes super-properties), then register the
     flag so it rides on every event; cleared flags are unregistered. */
  if (internalChanged === "set") posthog.reset();
  if (internalLabel) {
    posthog.register({ nl_internal: true, nl_internal_label: internalLabel });
  } else if (internalChanged === "cleared") {
    posthog.unregister("nl_internal");
    posthog.unregister("nl_internal_label");
  }

  /* ---------- Identity bridge ----------

     The whole point of the system. A visitor browses anonymously for weeks;
     the moment they arrive carrying a contact id — from an email link — we
     call identify(), and PostHog retroactively merges every anonymous
     session that browser ever had into the named person.

     History back-fills. That is why this ships before it is "needed". */

  if (contactId) {
    posthog.identify(contactId);
    if (fromUrl) {
      /* Only worth recording on the visit that actually carried the id —
         this is the click-through that created the link in the first place. */
      posthog.capture("identified_via_email_link", { landing_page: window.location.pathname });
    }
  }

  /* ---------- Form engagement ----------

     Answers where people stop. Someone who starts the booking form and never
     submits is a different problem from someone who never opened it, and we
     could not previously tell those apart.

     Three rules, all deliberate:

       1. NEVER capture field values. Field NAMES and COUNTS only. No name,
          email, phone or budget is ever sent to PostHog.

       2. website_confirm is a honeypot — class="hp-field", tabindex="-1",
          aria-hidden="true". A human cannot focus or fill it, so it is
          excluded everywhere: counting it would both pollute the funnel and
          send bot noise.

       3. form_submitted fires only on a CONFIRMED successful webhook, never
          on a submit click. Someone whose submission failed must not be
          counted as converted — they tried to reach us and got dropped, and
          they are the most important person in this dataset to catch. */

  var FORMS = { "book-form": "book", "contact-form": "contact" };
  var formStarted = {};

  Object.keys(FORMS).forEach(function (id) {
    var form = document.getElementById(id);
    if (!form) return;
    var label = FORMS[id];

    form.addEventListener("focusin", function (e) {
      var el = e.target;
      if (!el.name || el.name === "website_confirm") return;
      if (formStarted[label]) return;
      formStarted[label] = true;
      posthog.capture("form_started", { form: label });
    });

    form.addEventListener("submit", function () {
      var filled = [];
      var fields = form.querySelectorAll("[name]");
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.name === "website_confirm") continue;
        if (f.value && f.value.trim()) filled.push(f.name);
      }
      posthog.capture("form_attempted", {
        form: label, fields_filled: filled.length, fields: filled
      });
    });
  });

  /* ---------- Human confirmed ----------

     Security scanners (Safe Links and the like) open an emailed link, run the script and leave,
     so most "clicks" from outreach are not people. A person moves, taps, types or scrolls, or
     simply stays with the tab visible. human_confirmed fires ONCE per page view, on the first
     real input or after 3 seconds of the tab being visible, whichever comes first. Scanners do
     neither. Anything carrying this event is a person; anything without it is not proven to be. */

  (function () {
    var done = false, timer = null, visibleSince = 0, visibleMs = 0;
    /* "scroll" itself is NOT listened for: the browser fires it with no input at all (scroll
       restoration, anchors, scripts that scroll), which made every page view look human. Real
       scrolling always arrives with one of these: a wheel or trackpad, a finger moving, a key,
       or a pointer on the scrollbar. */
    var EVENTS = ["pointerdown", "keydown", "touchstart", "touchmove", "wheel"];
    function confirm(how) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      EVENTS.forEach(function (ev) { window.removeEventListener(ev, onInput, true); });
      document.removeEventListener("visibilitychange", onVisibility);
      posthog.capture("human_confirmed", { trigger: how });
    }
    function onInput(e) { confirm(e.type); }
    function startClock() {
      visibleSince = Date.now();
      timer = setTimeout(function () { confirm("visible_3s"); }, Math.max(0, 3000 - visibleMs));
    }
    function onVisibility() {
      if (done) return;
      if (document.visibilityState === "visible") {
        startClock();
      } else {
        if (timer) { clearTimeout(timer); timer = null; }
        visibleMs += Date.now() - visibleSince;
      }
    }
    EVENTS.forEach(function (ev) { window.addEventListener(ev, onInput, { capture: true, passive: true }); });
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") startClock();
  })();

  /* ---------- Phone and email link clicks ----------
     Which kind and from which page only. The number and address are ours, but the rule for
     this file stays: no values leave the page. */
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href^='tel:'], a[href^='mailto:']") : null;
    if (!a) return;
    posthog.capture("contact_link_click", {
      kind: a.getAttribute("href").indexOf("tel:") === 0 ? "tel" : "mailto",
      page: window.location.pathname
    });
  }, true);

  /* Fired by main.js only after the GoHighLevel webhook returns ok. */
  document.addEventListener("nl:form-success", function (e) {
    posthog.capture("form_submitted", { form: e.detail && e.detail.form });
  });

})();
