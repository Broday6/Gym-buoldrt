import { AuthError, api, esc, setAdminKey, state, toast } from './lib.js';
import { dashboard } from './views/dashboard.js';
import { tester } from './views/tester.js';
import { badges, collections } from './views/merchandising.js';
import { vocabulary } from './views/vocabulary.js';
import { catalog } from './views/catalog.js';

/**
 * Console shell.
 *
 * Routing, the site switcher, and the event plumbing every view shares. Views
 * are plain objects with `render`, plus optional `onClick` and `onAction`
 * handlers — the shell delegates to them rather than each view wiring its own
 * listeners, so a re-render never leaks a handler.
 */

const VIEWS = {
  dashboard: { group: 'Insights', view: dashboard },
  tester: { group: 'Insights', view: tester },
  collections: { group: 'Merchandising', view: collections },
  badges: { group: 'Merchandising', view: badges },
  vocabulary: { group: 'Merchandising', view: vocabulary },
  catalog: { group: 'Catalog', view: catalog },
};

const root = document.querySelector('#view');
const titleEl = document.querySelector('#view-title');
const subEl = document.querySelector('#view-sub');
const actionsEl = document.querySelector('#view-actions');
let current = 'dashboard';

async function boot() {
  const { sites } = await api('/v1/sites').catch(() => ({ sites: [] }));
  state.sites = sites;
  state.site = new URLSearchParams(location.search).get('site') ?? sites[0]?.id;

  const select = document.querySelector('#site');
  select.innerHTML = sites
    .map((s) => `<option value="${esc(s.id)}"${s.id === state.site ? ' selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  select.addEventListener('change', () => {
    state.site = select.value;
    // Every screen is scoped to the selected site, so switching resets any
    // half-finished editor rather than carrying it across tenants.
    collections.state.editing = null;
    badges.state.creating = false;
    void navigate(current);
  });

  drawNav();
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1) || 'dashboard'));
  await navigate(location.hash.slice(1) || 'dashboard');
}

function drawNav() {
  const nav = document.querySelector('#nav');
  const groups = new Map();
  for (const [key, entry] of Object.entries(VIEWS)) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push([key, entry.view]);
  }
  nav.innerHTML = [...groups.entries()].map(([group, items]) => `
    <p class="side__group">${esc(group)}</p>
    ${items.map(([key, view]) => `
      <button class="side__link" data-nav="${key}" aria-current="${key === current}">
        <span>${esc(view.title)}</span>
      </button>`).join('')}
  `).join('');
}

async function navigate(key, params) {
  if (!VIEWS[key]) key = 'dashboard';
  current = key;
  location.hash = key;
  for (const button of document.querySelectorAll('[data-nav]')) {
    button.setAttribute('aria-current', String(button.dataset.nav === key));
  }
  const { view } = VIEWS[key];
  titleEl.textContent = view.title;
  subEl.textContent = view.subtitle ?? '';
  actionsEl.innerHTML = view.actions?.() ?? '';
  await render(params);
}

async function render(params) {
  const { view } = VIEWS[current];
  try {
    await view.render(root, params);
  } catch (err) {
    if (err instanceof AuthError) {
      connectPanel(err.message);
      return;
    }
    root.innerHTML = `<div class="card"><p class="empty">${esc(err.message)}</p></div>`;
  }
}

/**
 * The key gate.
 *
 * Shown only when the API actually refuses a request, so a deployment that
 * runs the console behind its own authentication never sees it. The key is
 * asked for per site: an admin key is scoped to one tenant, and pretending
 * otherwise would fail confusingly on the second site.
 */
function connectPanel(message) {
  const site = state.sites.find((s) => s.id === state.site);
  root.innerHTML = `
    <div class="card connect">
      <h2 class="card__title">Connect to ${esc(site?.name ?? state.site)}</h2>
      <p class="card__hint">
        ${esc(message)}. Paste the admin key for this site — <code>npm run seed</code>
        prints it, and <code>npm run keys</code> issues new ones. It is kept in this
        browser only.
      </p>
      <div class="row" style="margin-top:12px">
        <label class="field grow">
          <span>Admin key</span>
          <input id="adminkey" type="password" autocomplete="off" spellcheck="false"
            placeholder="ck_admin_…">
        </label>
        <button class="btn btn--primary" data-connect>Connect</button>
      </div>
    </div>`;
  root.querySelector('#adminkey')?.focus();
}

const rerender = () => render();

/**
 * One delegated click handler for the whole console.
 *
 * Views declare what they respond to; the shell owns the listener. That is what
 * makes a full re-render safe — there is never a stale handler bound to an
 * element that no longer exists.
 */
document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-nav]');
  if (nav) {
    await navigate(nav.dataset.nav);
    return;
  }
  if (event.target.closest('[data-connect]')) {
    const value = root.querySelector('#adminkey')?.value.trim();
    if (!value) return toast('Paste an admin key first', true);
    setAdminKey(state.site, value);
    await render();
    return;
  }
  const { view } = VIEWS[current];
  try {
    if (event.target.closest('.topbar__actions')) {
      if (await view.onAction?.(event, rerender)) return;
    }
    await view.onClick?.(event, navigate, rerender);
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('change', async (event) => {
  if (!event.target.closest('.topbar__actions')) return;
  const { view } = VIEWS[current];
  try {
    await view.onAction?.(event, rerender);
  } catch (err) {
    toast(err.message, true);
  }
});

// Enter submits the key gate, which is the one form the shell owns itself.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.id === 'adminkey') {
    event.preventDefault();
    root.querySelector('[data-connect]')?.click();
  }
});

// A merchandiser lives in the query tester; give it the shortcut every tool has.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault();
    void navigate('tester');
  }
});

void boot();
