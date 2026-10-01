// =====================================================================
// sitetrace-api — shared "Sign in / Dashboard" nav toggle
//
// Drop this snippet into any page's <body> after the <nav> element:
//   <script src="/js/auth-nav.js"></script>
//
// What it does:
//   - Looks for any <a> tag inside the page with data-auth="in"
//   - If localStorage.sitetrace_key exists, swaps its text to "Dashboard"
//     and points it at /dashboard instead of /dashboard?next=...
//   - If the page itself is the dashboard and the user is signed out,
//     redirects to /signup so they can create an account
//   - Provides a global signOut() helper that clears the key + redirects
//
// Why a separate file: every page (pricing, signup, docs, etc.) renders
// its own nav HTML, so we want one place to update the auth-aware logic
// instead of duplicating it 10x.
// =====================================================================
(function () {
  const KEY = 'sitetrace_key';
  const links = document.querySelectorAll('a[data-auth="in"]');

  if (localStorage.getItem(KEY)) {
    links.forEach((a) => {
      a.textContent = 'Dashboard';
      a.setAttribute('href', '/dashboard');
      a.classList.remove('btn-primary');
    });
  }

  // Expose sign-out helper so any page can call window.signOut()
  window.signOut = function () {
    localStorage.removeItem(KEY);
    location.href = '/';
  };
})();
