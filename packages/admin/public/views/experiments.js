import { api, esc, money, num, pct, toast } from '../lib.js';

/**
 * Did the change help?
 *
 * Every other merchandising screen is about making a change. This one is about
 * finding out whether it was worth making — which until now nobody could,
 * because a rule went live for everyone and there was nothing to compare
 * against.
 *
 * The design fights one specific bad habit: checking a running experiment
 * every morning and stopping it the moment it looks good. Every look is
 * another chance to be fooled by noise, so a thin experiment shows no
 * percentage at all — not a small one, not a greyed-out one. There is nothing
 * to read yet, and the screen says so and tells you how much longer.
 */

const VERDICT = {
  better: { label: 'Winning', tone: 'pill--ok' },
  worse: { label: 'Losing', tone: 'pill--warn' },
  no_difference: { label: 'No difference', tone: '' },
  not_enough_data: { label: 'Too early', tone: '' },
};

const STATUS = {
  running: 'Running',
  stopped: 'Stopped',
  adopted: 'Kept',
  discarded: 'Discarded',
};

export const experiments = {
  title: 'Experiments',
  subtitle: 'Whether a merchandising change actually helped, measured against not making it',
  needs: 'analyst',

  async render(root) {
    const [{ experiments: all }, { rules }] = await Promise.all([
      api('/admin/experiments'),
      api('/admin/query-rules').catch(() => ({ rules: [] })),
    ]);

    const running = all.filter((e) => e.experiment.status === 'running');
    const finished = all.filter((e) => e.experiment.status !== 'running');
    // A rule can only be tested once at a time, and testing one that is off
    // would measure nothing against nothing.
    const tested = new Set(running.map((e) => e.experiment.ruleId));
    const available = rules.filter((r) => r.enabled && !tested.has(r.id));

    root.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Running</h2>
          <p class="card__hint">
            ${running.length
              ? 'Half the visitors see the change, half do not. Both are measured.'
              : 'Nothing is being tested right now'}
          </p>
        </div>
        ${running.length
          ? `<div class="proposals">${running.map(experimentCard).join('')}</div>`
          : `<p class="empty">
               Every rule you save goes live for everyone, and whether it helped is
               a guess. Start one below and it goes live for half instead.
             </p>`}
      </div>

      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Test a rule</h2>
          <p class="card__hint">Pick a rule you have already saved and split the traffic on it</p>
        </div>
        ${available.length ? `
          <div class="row">
            <label class="field grow"><span>Rule</span>
              <select id="exp-rule">
                ${available.map((r) => `<option value="${r.id}">${
                  esc(r.query || r.categoryId || `rule ${r.id}`)}</option>`).join('')}
              </select></label>
            <label class="field grow"><span>What do you expect to happen?</span>
              <input id="exp-hypothesis" placeholder="Pinning the three best sellers lifts add-to-cart">
            </label>
            <label class="field"><span>Show it to</span>
              <select id="exp-exposure">
                <option value="50" selected>Half of visitors</option>
                <option value="25">A quarter</option>
                <option value="10">One in ten</option>
              </select></label>
            <button class="btn btn--primary" id="exp-start" data-needs="merchandiser">Start</button>
          </div>
          <p class="prose">
            A visitor gets the same version for their whole visit, so what they see
            never changes underneath them. Nothing else about the rule changes, and
            you can stop at any time.
          </p>`
          : '<p class="empty">Save a merchandising rule first, then it can be tested here.</p>'}
      </div>

      ${finished.length ? `
        <div class="card">
          <div class="card__head">
            <h2 class="card__title">Finished</h2>
            <p class="card__hint">What was tried, and what was decided</p>
          </div>
          <div class="proposals">${finished.map(experimentCard).join('')}</div>
        </div>` : ''}`;
  },

  async onClick(event, navigate, rerender) {
    if (event.target.id === 'exp-start') {
      const ruleId = Number(document.querySelector('#exp-rule')?.value);
      if (!ruleId) return toast('Pick a rule first', true), true;
      try {
        await api('/admin/experiments', {
          body: {
            name: document.querySelector('#exp-rule')?.selectedOptions?.[0]?.textContent?.trim()
              || `rule ${ruleId}`,
            hypothesis: document.querySelector('#exp-hypothesis')?.value || undefined,
            ruleId,
            exposure: Number(document.querySelector('#exp-exposure')?.value ?? 50),
          },
        });
        toast('Started. Results appear once enough visitors have been through.');
        await rerender();
      } catch (err) {
        toast(err.message, true);
      }
      return true;
    }

    const end = event.target.closest('[data-end]');
    if (!end) return false;
    const { end: status, id } = end.dataset;
    await api(`/admin/experiments/${id}/end`, { body: { status } });
    toast(status === 'adopted'
      ? 'Kept. The change is now live for everyone.'
      : status === 'discarded'
        ? 'Discarded. The rule is switched off — your arrangement is still saved.'
        : 'Stopped. The change stays live for everyone.');
    await rerender();
    return true;
  },
};

function experimentCard(result) {
  const { experiment: e, control, treatment, verdict, summary, liftPct } = result;
  const meta = VERDICT[verdict] ?? { label: verdict, tone: '' };
  const running = e.status === 'running';
  // A lift is shown only when the comparison actually supports one. A
  // percentage sitting next to "no clear difference" is read as the answer no
  // matter what the label beside it says, and that is the whole failure mode
  // this screen exists to avoid.
  const readable = (verdict === 'better' || verdict === 'worse') && liftPct !== null;

  return `
    <article class="proposal">
      <div class="proposal__head">
        <span class="pill ${meta.tone}">${esc(running ? meta.label : STATUS[e.status])}</span>
        <strong class="proposal__summary">${esc(e.name)}</strong>
        ${readable
          ? `<span class="proposal__conf">${liftPct > 0 ? '+' : ''}${liftPct}% to cart</span>`
          : ''}
      </div>

      ${e.hypothesis ? `<p class="proposal__why">Expected: ${esc(e.hypothesis)}</p>` : ''}
      <p class="proposal__why">${esc(summary)}</p>

      <table class="table exp__table">
        <thead>
          <tr>
            <th></th>
            <th class="num">Visits</th>
            <th class="num">Clicked</th>
            <th class="num">Reached cart</th>
            <th class="num">Revenue</th>
          </tr>
        </thead>
        <tbody>
          ${[['With the change', treatment], ['Without it', control]].map(([label, arm]) => `
            <tr>
              <td>${label}</td>
              <td class="num">${num(arm.sessions)}</td>
              <td class="num">${pct(arm.clickRate * 100)}</td>
              <td class="num">${pct(arm.cartRate * 100)}</td>
              <td class="num">${money(arm.revenue)}</td>
            </tr>`).join('')}
        </tbody>
      </table>

      ${running ? `
        <div class="proposal__act">
          <button class="btn btn--sm btn--primary" data-needs="merchandiser"
            data-end="adopted" data-id="${e.id}">Keep the change</button>
          <button class="btn btn--sm" data-needs="merchandiser"
            data-end="discarded" data-id="${e.id}">Discard it</button>
          <button class="btn btn--sm" data-needs="merchandiser"
            data-end="stopped" data-id="${e.id}">Just stop testing</button>
          <span class="proposal__reach">Started ${new Date(e.startedAt).toLocaleDateString()}</span>
        </div>`
        : `<div class="proposal__act">
             <span class="proposal__reach">
               ${esc(STATUS[e.status])}
               ${e.endedAt ? `on ${new Date(e.endedAt).toLocaleDateString()}` : ''}
             </span>
           </div>`}
    </article>`;
}
