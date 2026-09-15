/* NewLife Client Portal — auth layer (Supabase, LIVE — no demo mode).
   Email/password sign-in, session guarding on every portal page, profile
   loading (per-client identity via public.profiles → public.clients),
   logout and password reset. The anon key in config.js is browser-safe by
   design; all real protection is Supabase Auth + Row-Level Security. */
(function () {
  "use strict";

  var cfg = window.PORTAL_CONFIG || {};
  var LIB = window.supabase; /* UMD global from the supabase-js CDN script */
  var configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && LIB);

  /* ---- "Keep me signed in": persistent (localStorage) vs tab-only
     (sessionStorage). The preference is recorded at login time; this
     adapter reads from either store so an existing session is found on
     any portal page, and writes to whichever store the user chose. ---- */
  var REMEMBER_KEY = "pl-remember";
  function rememberOn() {
    try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch (e) { return true; }
  }
  var dualStorage = {
    getItem: function (k) {
      var v = null;
      try { v = sessionStorage.getItem(k); } catch (e) {}
      if (v === null) { try { v = localStorage.getItem(k); } catch (e) {} }
      return v;
    },
    setItem: function (k, v) {
      try { (rememberOn() ? localStorage : sessionStorage).setItem(k, v); } catch (e) {}
    },
    removeItem: function (k) {
      try { sessionStorage.removeItem(k); } catch (e) {}
      try { localStorage.removeItem(k); } catch (e) {}
    }
  };

  var sb = configured
    ? LIB.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: {
          storage: dualStorage,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true /* handles the password-recovery link hash */
        }
      })
    : null;

  function qs(id) { return document.getElementById(id); }
  function go(path) { window.location.href = path; }

  var NOT_CONFIGURED_MSG =
    "Sign-in is temporarily unavailable — the portal isn't connected to its " +
    "authentication service. Please email contact@newlifemarketing.ca.";

  /* ================= LOGIN PAGE ================= */
  var loginForm = qs("pl-login-form");
  if (loginForm) {
    var errBox = qs("pl-login-error");
    function showErr(msg) {
      if (!errBox) { alert(msg); return; }
      errBox.textContent = msg;
      errBox.style.display = "block";
    }

    /* Already signed in? Straight to the dashboard. */
    if (sb) {
      sb.auth.getSession().then(function (res) {
        if (res.data && res.data.session) window.location.replace("/portal/dashboard/");
      });
    }

    loginForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (errBox) errBox.style.display = "none";
      if (!sb) { showErr(NOT_CONFIGURED_MSG); return; }

      /* Record the "Keep me signed in" choice BEFORE the token is stored,
         so the storage adapter writes it to the right place. */
      var remember = loginForm.querySelector("[name=remember]");
      try { localStorage.setItem(REMEMBER_KEY, (remember && remember.checked) ? "1" : "0"); } catch (err) {}

      var email = loginForm.querySelector("[name=email]").value.trim();
      var password = loginForm.querySelector("[name=password]").value;
      if (!email || !password) { showErr("Enter your email and password."); return; }
      var btn = loginForm.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Signing in…";
      sb.auth.signInWithPassword({ email: email, password: password })
        .then(function (res) {
          if (res.error) {
            showErr(res.error.message === "Invalid login credentials"
              ? "That email and password don't match an account. Check both, or use “Forgot password?”."
              : res.error.message);
            btn.disabled = false; btn.textContent = "Sign In";
            return;
          }
          go("/portal/dashboard/");
        })
        .catch(function () {
          showErr("Couldn't reach the sign-in service. Check your connection and try again.");
          btn.disabled = false; btn.textContent = "Sign In";
        });
    });

    var forgot = qs("pl-forgot");
    if (forgot) forgot.addEventListener("click", function (e) {
      e.preventDefault();
      if (!sb) { showErr(NOT_CONFIGURED_MSG); return; }
      var email = (loginForm.querySelector("[name=email]").value || "").trim();
      if (!email) { showErr("Enter your email above first, then click “Forgot password?”."); return; }
      sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + "/portal/reset/" })
        .then(function () { showErr("If that email has an account, a reset link is on its way."); });
    });
  }

  /* ================= PORTAL PAGE GUARD =================
     Any page with #pl-app (dashboard + future report pages) requires a
     valid session. Content stays hidden (see the pl-guard style in the
     page <head>) until the session is confirmed; no session — or no
     Supabase config at all — bounces straight to the login page. */
  /* Persistent bar so an admin can never mistake a client's dashboard for
     their own — and always has one click back to the console. */
  function adminBanner(clientName) {
    if (document.getElementById("pl-admin-bar")) return;
    var bar = document.createElement("div");
    bar.id = "pl-admin-bar";
    bar.className = "pl-admin-bar";
    bar.innerHTML =
      '<span class="pl-admin-dot" aria-hidden="true"></span>' +
      '<span>Viewing as <strong></strong> \u2014 read-only admin view</span>' +
      '<a class="pl-admin-exit" href="/portal/admin/">Back to console</a>';
    bar.querySelector("strong").textContent = clientName || "client";
    document.body.appendChild(bar);
    document.body.classList.add("has-admin-bar");
  }

  var app = qs("pl-app");
  if (app) {
    if (!sb) {
      window.location.replace("/portal/");
    } else {
      sb.auth.getSession().then(function (res) {
        var session = res.data && res.data.session;
        if (!session) { window.location.replace("/portal/"); return; }

        /* Session confirmed — reveal the app. */
        document.documentElement.classList.add("pl-authed");

        /* Identity: start with the signed-in email, upgrade to the
           profile + client name from public.profiles once loaded. */
        var nameEl = qs("pl-clientname"), bizEl = qs("pl-clientbiz"), initEl = qs("pl-initials");
        function setInitials(src) {
          if (!initEl || !src) return;
          initEl.textContent = src.split(/[\s@]+/).slice(0, 2).map(function (w) { return (w[0] || "").toUpperCase(); }).join("");
        }
        if (nameEl) nameEl.textContent = session.user.email || "Signed in";
        if (bizEl) bizEl.textContent = "";
        setInitials(session.user.email || "");

        sb.from("profiles")
          .select("client_id, full_name, role, clients(name, business_name, sections)")
          .eq("id", session.user.id)
          .single()
          .then(function (r) {
            var p = r.data;
            var isAdmin = !!(p && p.role === "admin");

            /* Admin "view as": ?client=<uuid> renders that client's dashboard.
               This is NOT auth impersonation — no session is swapped and no
               elevated key is used. The admin stays themselves; RLS already
               lets an admin read every client's rows, so the ordinary
               dashboard simply reads a different client_id. A non-admin who
               types the same URL is ignored below, and would be stopped by RLS
               even if it weren't. */
            var asClient = null;
            try {
              var qp = new URLSearchParams(window.location.search).get("client");
              if (isAdmin && qp && /^[0-9a-f-]{36}$/i.test(qp)) asClient = qp;
            } catch (e) {}

            function publish(clientRow) {
              window.PORTAL_CTX = {
                sb: sb,
                session: session,
                profile: p || null,
                isAdmin: isAdmin,
                viewingAs: asClient ? (clientRow || { id: asClient }) : null,
                clientId: asClient ? asClient : (p ? p.client_id : null),
                client: asClient ? (clientRow || null) : (p && p.clients ? p.clients : null),
                sections: asClient
                  ? ((clientRow && clientRow.sections) || [])
                  : ((p && p.clients && p.clients.sections) ? p.clients.sections : [])
              };
              document.dispatchEvent(new CustomEvent("portal:ready", { detail: window.PORTAL_CTX }));

              var shown = asClient
                ? (clientRow ? (clientRow.business_name || clientRow.name) : "Unknown client")
                : (p && p.clients ? (p.clients.business_name || p.clients.name) : "");
              if (nameEl) nameEl.textContent = asClient
                ? shown
                : ((p && p.full_name) || session.user.email || "Signed in");
              if (bizEl) bizEl.textContent = asClient ? "Viewed by " + (p && p.full_name ? p.full_name : "admin") : shown;
              setInitials(shown || (p && p.full_name) || session.user.email || "");
              if (asClient) adminBanner(shown);
            }

            if (asClient) {
              /* Pull the impersonated client's own row so sections and name are
                 theirs, not the admin's. */
              sb.from("clients").select("id, name, business_name, sections")
                .eq("id", asClient).single()
                .then(function (cr) { publish(cr.data || null); });
            } else {
              publish(null);
            }
          });
      });

      /* If the session dies while the page is open (expiry / signed out
         elsewhere), bounce to login. */
      sb.auth.onAuthStateChange(function (event) {
        if (event === "SIGNED_OUT") window.location.replace("/portal/");
      });
    }

    var logout = qs("pl-logout");
    if (logout) logout.addEventListener("click", function (e) {
      e.preventDefault();
      if (!sb) { window.location.replace("/portal/"); return; }
      sb.auth.signOut().then(function () { window.location.replace("/portal/"); });
    });
  }

  /* ================= PASSWORD RESET PAGE =================
     Reached from the Supabase recovery email; detectSessionInUrl picks up
     the recovery token from the URL when the page loads. */
  var resetForm = qs("pl-reset-form");
  if (resetForm) {
    var rErr = qs("pl-reset-msg");
    function rMsg(m) { if (rErr) { rErr.textContent = m; rErr.style.display = "block"; } }
    if (!sb) { rMsg(NOT_CONFIGURED_MSG); }
    resetForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!sb) { rMsg(NOT_CONFIGURED_MSG); return; }
      var pw = resetForm.querySelector("[name=password]").value;
      var pw2 = resetForm.querySelector("[name=confirm]").value;
      if (pw.length < 8) { rMsg("Use at least 8 characters."); return; }
      if (pw !== pw2) { rMsg("Passwords don't match."); return; }
      sb.auth.updateUser({ password: pw }).then(function (res) {
        if (res.error) {
          rMsg(res.error.message.indexOf("session") !== -1
            ? "This page only works from the reset link in your email. Request a new link from the sign-in page."
            : res.error.message);
          return;
        }
        rMsg("Password updated. Redirecting to sign in…");
        setTimeout(function () { window.location.replace("/portal/"); }, 1500);
      });
    });
  }
})();
