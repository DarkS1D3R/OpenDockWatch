// Lives in its own file rather than inline in login.html so the CSP in server/index.js can be a
// plain script-src 'self' with no 'unsafe-inline' escape hatch - one inline block here would have
// to open that up for every page, including the one rendering container log output via v-html.
const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const body = Object.fromEntries(new FormData(form).entries());
  const res = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    window.location.href = '/';
  } else {
    errorEl.hidden = false;
  }
});
