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

  /* TODO(keegan): create a free PostHog project and paste its key here.
     Until this is filled in, nothing below runs — no requests, no cookies,
     no console noise. The site behaves exactly as it does today. */
  var POSTHOG_KEY = "";
  var POSTHOG_HOST = "https://us.i.posthog.com";

  /* Query params that carry a GHL contact id into the site. `nl_cid` is ours;
     `contact_id` is what GHL's own merge field produces. Either works. */
  var ID_PARAMS = ["nl_cid", "contact_id"];
  var STORE_KEY = "nl_contact_id";

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

  /* ---------- Identity bridge ---------- */

  /* The whole point of the system. A visitor browses anonymously for weeks;
     the moment they arrive carrying a contact id — from an email link — we
     call identify(), and PostHog retroactively merges every anonymous
     session that browser ever had into the named person.

     History back-fills. That is why this ships before it is "needed". */

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
     links, screenshots, and the referrer we send to third parties. */
  function scrubUrl() {
    if (!window.history || !window.history.replaceState) return;
    var url = new URL(window.location.href);
    var touched = false;
    ID_PARAMS.forEach(function (p) {
      if (url.searchParams.has(p)) { url.searchParams.delete(p); touched = true; }
    });
    if (touched) window.history.replaceState({}, document.title, url.toString());
  }

  var fromUrl = readIdFromUrl();
  var contactId = fromUrl || recall();

  if (contactId) {
    posthog.identify(contactId);
    if (fromUrl) {
      store(contactId);
      /* Only worth recording on the visit that actually carried the id —
         this is the click-through that created the link in the first place. */
      posthog.capture("identified_via_email_link", { landing_page: window.location.pathname });
      scrubUrl();
    }
  }
})();
