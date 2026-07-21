/* NewLife Client Portal — auth layer (Phase 2, A2 / Supabase).
   If config.js has Supabase values, this runs REAL email/password auth,
   session guarding, profile loading, logout and password reset.
   If not configured, it falls back to the Phase-1 demo flow so the
   preview stays usable. No secrets live here. */
(function () {
  "use strict";

  var cfg = window.PORTAL_CONFIG || {};
  var configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
  var sb = configured
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;
  window.PORTAL_LIVE = !!sb;

  function qs(id) { return document.getElementById(id); }
  function go(path) { window.location.href = path; }

  /* ================= LOGIN PAGE ================= */
  var loginForm = qs("pl-login-form");
  if (loginForm) {
    var errBox = qs("pl-login-error");
    var demoHint = document.querySelector(".pl-demo-hint");
    // When live, hide the "demo preview" note.
    if (sb && demoHint) demoHint.style.display = "none";

    function showErr(msg) {
      if (!errBox) { alert(msg); return; }
      errBox.textContent = msg;
      errBox.style.display = "block";
    }

    loginForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (errBox) errBox.style.display = "none";
      if (!sb) { go("/portal/dashboard/"); return; }        // demo mode
      var email = loginForm.querySelector("[name=email]").value.trim();
      var password = loginForm.querySelector("[name=password]").value;
      var btn = loginForm.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Signing in…";
      sb.auth.signInWithPassword({ email: email, password: password })
        .then(function (res) {
          if (res.error) { showErr(res.error.message); btn.disabled = false; btn.textContent = "Sign In"; return; }
          go("/portal/dashboard/");
        });
    });

    var forgot = qs("pl-forgot");
    if (forgot) forgot.addEventListener("click", function (e) {
      e.preventDefault();
      if (!sb) { alert("Password reset activates once Supabase is connected (see PORTAL-SETUP.md)."); return; }
      var email = (loginForm.querySelector("[name=email]").value || "").trim();
      if (!email) { showErr("Enter your email above first, then click “Forgot password?”."); return; }
      sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + "/portal/reset/" })
        .then(function () { showErr("If that email has an account, a reset link is on its way."); });
    });
  }

  /* ================= DASHBOARD GUARD ================= */
  var app = qs("pl-app");
  if (app && sb) {
    // Not logged in → bounce to login.
    sb.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (!session) { window.location.replace("/portal/"); return; }
      // Load this user's profile + client for the sidebar footer.
      sb.from("profiles")
        .select("full_name, role, clients(name, business_name, sections)")
        .eq("id", session.user.id)
        .single()
        .then(function (r) {
          var p = r.data;
          if (!p) return;
          var biz = p.clients ? (p.clients.business_name || p.clients.name) : "";
          var nameEl = qs("pl-clientname"), bizEl = qs("pl-clientbiz"), initEl = qs("pl-initials");
          if (nameEl && p.full_name) nameEl.textContent = p.full_name;
          if (bizEl && biz) bizEl.textContent = biz;
          if (initEl) {
            var src = p.full_name || biz || "Client";
            initEl.textContent = src.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase();
          }
          // (Later) hide sidebar sections not in p.clients.sections here.
        });
    });

    var logout = qs("pl-logout");
    if (logout) logout.addEventListener("click", function (e) {
      e.preventDefault();
      sb.auth.signOut().then(function () { window.location.replace("/portal/"); });
    });
  }

  /* ================= PASSWORD RESET PAGE ================= */
  var resetForm = qs("pl-reset-form");
  if (resetForm) {
    var rErr = qs("pl-reset-msg");
    function rMsg(m) { if (rErr) { rErr.textContent = m; rErr.style.display = "block"; } }
    if (!sb) { rMsg("Password reset activates once Supabase is connected."); }
    resetForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!sb) return;
      var pw = resetForm.querySelector("[name=password]").value;
      var pw2 = resetForm.querySelector("[name=confirm]").value;
      if (pw.length < 8) { rMsg("Use at least 8 characters."); return; }
      if (pw !== pw2) { rMsg("Passwords don't match."); return; }
      sb.auth.updateUser({ password: pw }).then(function (res) {
        if (res.error) { rMsg(res.error.message); return; }
        rMsg("Password updated. Redirecting to sign in…");
        setTimeout(function () { window.location.replace("/portal/"); }, 1500);
      });
    });
  }
})();
