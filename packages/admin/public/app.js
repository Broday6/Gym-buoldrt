import { AuthError, api, applyRole, esc, roleCovers, setAdminKey, state, toast } from './lib.js';
import { dashboard } from './views/dashboard.js';
import { tester } from './views/tester.js';
import { badges, collections } from './views/merchandising.js';
import { vocabulary } from './views/vocabulary.js';
import { catalog } from './views/catalog.js';
import { history } from './views/history.js';
import { merchandiser } from './views/merchandiser.js';
import { quality } from './views/quality.js';
import { autopilot } from './views/autopilot.js';
import { guide } from './views/guide.js';
import { experiments } from './views/experiments.js';

/**
 * Console shell.
 *
 * Routing, the site switcher, and the event plumbing every view shares. Views
 * are plain objects with `render`, plus optional `onClick` and `onAction`
 * handlers — the shell delegates to them rather than each view wiring its own
 * listeners, so a re-render never leaks a handler.
 */

// `needs` is the least role that can make use of the screen at all. Controls
// inside a screen that need more carry their own data-needs.
/**
 * Areas, and the screens inside them.
 *
 * The rail lists areas; a screen with siblings appears as a tab in the page
 * header. Nine entries in one flat list is a menu you read every time — six
 * areas is a shape you learn once and then navigate from memory.
 */
const ICONS = {
  dashboard: '<path d="M3 12l9-8 9 8"/><path d="M5 10.5V20h14v-9.5"/>',
  reporting: '<path d="M4 20V9M10 20V4M16 20v-7M22 20H2"/>',
  merchandising: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  preview: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
  vocabulary: '<path d="M4 5.5h16M4 12h11M4 18.5h7"/>',
  data: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  guide: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.5.2-.7.6-.7 1.1v.6"/><path d="M12 17h.01"/>',
};

/**
 * An area carries no permission of its own: it is visible when any screen
 * inside it is. Declaring both invites them to disagree — which they did, and
 * an analyst lost access to History because the area around it asked for more
 * than the screen did.
 */
const AREAS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'reporting', label: 'Reporting' },
  { id: 'merchandising', label: 'Merchandising' },
  { id: 'preview', label: 'Search preview' },
  { id: 'vocabulary', label: 'Vocabulary' },
  { id: 'data', label: 'Data' },
  { id: 'guide', label: 'Guide' },
];

const VIEWS = {
  dashboard: { area: 'dashboard', label: 'Overview', view: dashboard, needs: 'analyst', windowed: true },
  autopilot: { area: 'merchandising', label: 'Recommendations', view: autopilot, needs: 'analyst' },
  experiments: { area: 'merchandising', label: 'Experiments', view: experiments, needs: 'analyst' },
  quality: { area: 'reporting', label: 'Search quality', view: quality, needs: 'analyst', windowed: true },
  merchandiser: { area: 'merchandising', label: 'Merchandiser', view: merchandiser, needs: 'merchandiser' },
  collections: { area: 'merchandising', label: 'Collections', view: collections, needs: 'merchandiser' },
  badges: { area: 'merchandising', label: 'Badges', view: badges, needs: 'merchandiser' },
  history: { area: 'merchandising', label: 'History', view: history, needs: 'analyst' },
  tester: { area: 'preview', label: 'Query tester', view: tester, needs: 'search' },
  vocabulary: { area: 'vocabulary', label: 'Synonyms & redirects', view: vocabulary, needs: 'merchandiser' },
  data: { area: 'data', label: 'Index status', view: catalog, needs: 'analyst' },
  guide: { area: 'guide', label: 'How to use this', view: guide, needs: 'search' },
};

const screensIn = (area) =>
  Object.entries(VIEWS).filter(([, v]) => v.area === area && roleCovers(v.needs));

const permitted = (key) => Boolean(VIEWS[key]) && roleCovers(VIEWS[key].needs);

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
  select.addEventListener('change', async () => {
    state.site = select.value;
    closeDrawer();
    // Every screen is scoped to the selected site, so switching resets any
    // half-finished editor rather than carrying it across tenants.
    collections.state.editing = null;
    badges.state.creating = false;
    // A key for one tenant says nothing about the next, so the role is re-read
    // rather than carried across — including the case where there is no key
    // for the site just selected.
    void enter();
  });

  bindDrawer();
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1) || 'dashboard'));
  await enter();
}

/**
 * The sidebar as a drawer, below 900px.
 *
 * Opening is explicit; closing is everything a person might reasonably do to
 * dismiss it — the scrim, Escape, picking a destination, or switching site. A
 * drawer that only closes one way is a trap on a touch screen.
 */
function bindDrawer() {
  const side = document.querySelector('#side');
  const scrim = document.querySelector('#scrim');
  const button = document.querySelector('#menu');

  const setOpen = (open) => {
    side.dataset.open = String(open);
    scrim.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) side.querySelector('[data-nav]')?.focus();
  };
  closeDrawer = () => {
    if (side.dataset.open === 'true') setOpen(false);
  };

  button.addEventListener('click', () => setOpen(side.dataset.open !== 'true'));
  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

/** Set by bindDrawer; a no-op until then, and harmless on a wide screen. */
let closeDrawer = () => {};

/**
 * Establish who we are, then show the console.
 *
 * `/whoami` is the authentication probe: it is the cheapest authenticated call
 * there is, and its failure is exactly the "no usable key" signal. Asking here
 * means the gate appears immediately rather than on whichever screen happens to
 * make the first request — a read-only role could otherwise land on a screen
 * that fetches nothing and see a console that looks broken instead of locked.
 */
async function enter() {
  if (!(await loadRole())) {
    drawNav();
    connectPanel('This console needs an admin key');
    return;
  }
  drawNav();
  await navigate(location.hash.slice(1) || 'dashboard');
}

/**
 * Ask what this key can do.
 *
 * A failure here is not fatal: the key gate will fire on the first real request
 * and say so properly. Assume the least until told otherwise, so a console that
 * cannot ask never offers writes it has no authority for.
 */
async function loadRole() {
  const chip = document.querySelector('#role');
  try {
    const who = await api('/whoami');
    state.role = who.role;
    state.can = who.can;
    chip.textContent = who.role;
    chip.title = who.description ?? '';
    return true;
  } catch (err) {
    // Assume the least until told otherwise, so a console that cannot ask
    // never offers a write it has no authority for.
    state.role = 'search';
    state.can = { search: true, analytics: false, merchandise: false, administer: false };
    chip.textContent = 'not connected';
    chip.title = '';
    return !(err instanceof AuthError);
  }
}

function drawNav() {
  const nav = document.querySelector('#nav');
  nav.innerHTML = AREAS
    .filter((a) => screensIn(a.id).length > 0)
    .map((a) => `
      <button class="rail__link" data-area="${a.id}" aria-current="false">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[a.id] ?? ''}</svg>
        <span>${esc(a.label)}</span>
      </button>`).join('');
}

/** The screens inside the current area, when there is more than one. */
function drawTabs(key) {
  const tabs = document.querySelector('#tabs');
  const area = VIEWS[key]?.area;
  const siblings = area ? screensIn(area) : [];
  tabs.innerHTML = siblings.length > 1
    ? siblings.map(([id, v]) => `
        <button class="tab" data-nav="${id}" aria-current="${id === key}">${esc(v.label)}</button>`).join('')
    : '';
  for (const link of document.querySelectorAll('[data-area]')) {
    link.setAttribute('aria-current', String(link.dataset.area === area));
  }
}

async function navigate(key, params) {
  // A deep link into a screen this role cannot use lands on the first one it
  // can, rather than on an error it can do nothing about.
  if (!permitted(key)) key = Object.keys(VIEWS).find(permitted) ?? 'tester';
  current = key;
  location.hash = key;
  for (const button of document.querySelectorAll('[data-nav]')) {
    button.setAttribute('aria-current', String(button.dataset.nav === key));
  }
  drawTabs(key);
  // A reporting window means nothing on a screen with nothing to report.
  document.querySelector('#range-wrap').hidden = !VIEWS[key].windowed;
  const { view } = VIEWS[key];
  titleEl.textContent = view.title;
  subEl.textContent = view.subtitle ?? '';
  actionsEl.innerHTML = view.actions?.() ?? '';
  applyRole(actionsEl);
  await render(params);
}

async function render(params) {
  const { view } = VIEWS[current];
  try {
    await view.render(root, params);
    applyRole(root);
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
  const area = event.target.closest('[data-area]');
  if (area) {
    closeDrawer();
    const [first] = screensIn(area.dataset.area);
    if (first) await navigate(first[0]);
    return;
  }
  const nav = event.target.closest('[data-nav]');
  if (nav) {
    closeDrawer();
    await navigate(nav.dataset.nav);
    return;
  }
  if (event.target.closest('[data-connect]')) {
    const value = root.querySelector('#adminkey')?.value.trim();
    if (!value) return toast('Paste an admin key first', true);
    setAdminKey(state.site, value);
    await enter();
    return;
  }
  const { view } = VIEWS[current];
  try {
    if (event.target.closest('.pagehead__actions')) {
      if (await view.onAction?.(event, rerender)) return;
    }
    await view.onClick?.(event, navigate, rerender);
  } catch (err) {
    toast(err.message, true);
  }
});

// The merchandiser owns a search box and a category picker inside its view,
// which the shell's header-only handler would never see.
document.addEventListener('input', debounceInput(async (event) => {
  if (event.target.id === 'merch-q') {
    merchandiser.state.query = event.target.value;
    merchandiser.state.actions = [];
    await merchandiser.preview();
    await render();
  }
}, 350));

document.addEventListener('change', async (event) => {
  if (event.target.id === 'range') {
    // One window for everything on screen: two cards reporting different
    // periods is a bug you only notice after acting on it.
    state.days = Number(event.target.value);
    return render();
  }
  if (event.target.id === 'merch-cat') {
    merchandiser.state.categoryId = event.target.value;
    merchandiser.state.actions = [];
    await merchandiser.preview();
    return render();
  }
  if (!event.target.closest('.pagehead__actions')) return;
  const { view } = VIEWS[current];
  try {
    await view.onAction?.(event, rerender);
  } catch (err) {
    toast(err.message, true);
  }
});

/** One trailing call per burst of keystrokes, so typing does not queue searches. */
function debounceInput(handler, wait) {
  let timer = null;
  return (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => handler(event), wait);
  };
}

/**
 * Drag to reorder, delegated like every other interaction.
 *
 * Dropping a card is the whole gesture: the slot it lands in is the position it
 * pins to, so a merchandiser never types a number.
 */
let dragging = null;
document.addEventListener('dragstart', (event) => {
  const tile = event.target.closest?.('.mtile');
  if (!tile) return;
  dragging = tile.dataset.parent;
  tile.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragend', (event) => {
  event.target.closest?.('.mtile')?.classList.remove('is-dragging');
  for (const el of document.querySelectorAll('.mtile.is-over')) el.classList.remove('is-over');
});
document.addEventListener('dragover', (event) => {
  const tile = event.target.closest?.('.mtile');
  if (!tile || !dragging) return;
  event.preventDefault();
  tile.classList.add('is-over');
});
document.addEventListener('dragleave', (event) => {
  event.target.closest?.('.mtile')?.classList.remove('is-over');
});
document.addEventListener('drop', async (event) => {
  const tile = event.target.closest?.('.mtile');
  if (!tile || !dragging) return;
  event.preventDefault();
  const position = Number(tile.dataset.index) + 1;
  merchandiser.setAction(dragging, 'pin', position);
  dragging = null;
  await merchandiser.preview();
  await render();
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
