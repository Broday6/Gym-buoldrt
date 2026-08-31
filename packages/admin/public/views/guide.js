import { esc } from '../lib.js';

/**
 * How to use this thing.
 *
 * Written for the person who was handed the login and told to improve search,
 * not for whoever built it. Three rules it follows:
 *
 *   - **Every step is a real one.** The screenshots are of this console with a
 *     real catalogue in it, and the numbers quoted are the ones that produced
 *     the advice. A guide illustrated with invented figures teaches people to
 *     distrust the guide.
 *   - **Jobs, not features.** Nobody arrives wanting to "configure synonyms".
 *     They arrive because a shopper could not find shutters.
 *   - **Say what a word means the first time it is used.** Every term the
 *     console shows anywhere is defined at the bottom of this page.
 */

const JOBS = [
  {
    id: 'find',
    n: 1,
    title: 'Find out what is going wrong',
    where: 'Dashboard',
    lead: `Start here every time. The four numbers across the top are the health of
      search; the table underneath is the list of searches that failed, busiest first.`,
    shot: 'dashboard.png',
    alt: 'The dashboard: four headline numbers, a traffic chart, and a table of failing searches',
    steps: [
      'Read the second card, <strong>Searches that found nothing</strong>. Under it is a plain reading — whether that figure is normal for a store or worth acting on.',
      'Scroll to <strong>Queries that need attention</strong>. Every row is a real search a real shopper typed that returned nothing or nearly nothing.',
      'Each row ends in the three things you can do about it, so you never have to go and find the screen yourself.',
    ],
    example: {
      title: 'A worked example',
      body: `On the demo catalogue this table's top row is <code>corbel</code> —
        <strong>45 searches, 0 results, every time</strong>. The catalogue is full of
        corbels; they are filed under "brackets". Forty-five shoppers asked for a
        product this store sells and were told it does not exist. That is the single
        most valuable thing on the screen, and it took no analysis to find.`,
    },
  },
  {
    id: 'vocabulary',
    n: 2,
    title: 'Teach it a word it does not know',
    where: 'Vocabulary',
    lead: `When shoppers use a word your catalogue does not, a synonym fixes it in
      seconds. Nothing is rebuilt — the next search already knows.`,
    shot: 'vocabulary.png',
    alt: 'The vocabulary screen, with the searches that found nothing offered as starting points',
    steps: [
      'The failing searches are listed for you under the synonym form. Click one and it fills the form in.',
      'Choose <strong>One-way</strong> when a word shoppers use should find products described differently — "corbel" should find brackets, but not every bracket search should return corbels.',
      'Choose <strong>Two-way</strong> when both words mean the same thing and either should find both — "sofa" and "couch".',
      'Press <strong>Add</strong>. Search the term yourself on the Search preview screen to confirm.',
    ],
    example: {
      title: 'Fixing corbel',
      body: `Kind <strong>One-way</strong>, when a shopper types <code>corbel</code>,
        terms <code>bracket</code>. Forty-five searches a month that returned nothing
        now return the bracket range. No reindex, no deploy — the next shopper to
        type it gets results.`,
    },
  },
  {
    id: 'arrange',
    n: 3,
    title: 'Decide what comes first',
    where: 'Merchandising → Merchandiser',
    lead: `For a search that already works, this is where you choose the order. You see
      exactly the grid a shopper sees, and drag products to where they should be.`,
    shot: 'merchandiser.png',
    alt: 'The merchandiser, offering the busiest searches as starting points',
    steps: [
      'Pick one of your busiest searches — they are listed for you — or type any term.',
      'The grid is the real result page, with your unsaved changes already applied. What you see is what ships.',
      'Drag a product to a slot to pin it there, or use the buttons on a card to push it down or hide it from this search.',
      'The header counts what you have changed. Press <strong>Save rule</strong> to publish, or <strong>Discard</strong> to walk away.',
    ],
    example: {
      title: 'When to reach for this',
      body: `Use it when the products are right but the order is not — a seasonal line
        you want first for "beams", or a discontinued item that keeps turning up.
        If you find yourself doing this for dozens of searches, look at
        <strong>Recommendations</strong> instead: it finds them for you.`,
    },
  },
  {
    id: 'recommend',
    n: 4,
    title: 'Let it tell you what to change',
    where: 'Merchandising → Recommendations',
    lead: `Nobody can inspect every search on a catalogue this size. This screen reads a
      month of shopper behaviour and proposes the specific changes the numbers support,
      each with the evidence attached.`,
    shot: 'autopilot.png',
    alt: 'The recommendations screen: proposed changes, each with the numbers behind it',
    steps: [
      'Each card says what it would change and why, with the counts that produced it.',
      'Check the evidence, then press <strong>Apply</strong> — or <strong>Dismiss</strong>, and it stops being offered.',
      '<strong>Worth a look</strong>, further down, is for products shown constantly and never clicked. Those are never applied for you: a product nobody clicks is often a missing photograph, not a bad product.',
      'Everything applied here lands in <strong>History</strong> and can be undone in one click.',
    ],
    example: {
      title: 'What it found on the demo',
      body: `<em>Move 3 products to the top of "beam"</em> — those three earned
        <strong>19 clicks from an average position of 12.7</strong>, meaning shoppers
        were scrolling past everything ranked above them to get there. Applying it
        moved them to the top of a search that runs 349 times a month.`,
    },
  },
  {
    id: 'check',
    n: 5,
    title: 'Check it worked, and undo it if it did not',
    where: 'Search preview and History',
    lead: `Every change is reversible, and you can see the effect before anyone else does.`,
    shot: 'history.png',
    alt: 'The history screen: who changed what, and a button to undo it',
    steps: [
      '<strong>Search preview</strong> runs any search as a shopper would see it, and can show you why each result ranked where it did.',
      '<strong>History</strong> lists every change: who made it, when, what moved, and an <strong>Undo</strong> button.',
      'Undoing is itself recorded as a change, so it too can be undone.',
    ],
    example: {
      title: 'Nothing here is one-way',
      body: `Changes made automatically appear in the same list, under
        <code>autopilot</code>, and undo exactly the same way. If a change made things
        worse, you are one click from before.`,
    },
  },
];

const GLOSSARY = [
  ['Search that found nothing', 'A shopper searched and got an empty page. The most expensive thing search can do.'],
  ['Rescued', 'The search found nothing literally, so the engine corrected a spelling or relaxed the wording and showed something relevant instead. The shopper still saw products.'],
  ['Led to a click', 'The share of searches where the shopper clicked a result. Low means they looked and did not find it.'],
  ['Pin', 'Force a product to a specific slot for one search, ahead of whatever the ranking would have chosen.'],
  ['Push down', 'Send a product to the end of the results for one search without removing it.'],
  ['Hide', 'Remove a product from one search entirely. It still exists everywhere else.'],
  ['Synonym', 'A word swap applied as the search runs. Two-way means either word finds both; one-way rewrites in a single direction.'],
  ['Redirect', 'Some searches are navigation, not shopping — "returns", "shipping". A redirect sends them to the right page instead of a product grid.'],
  ['Collection', 'A group of products defined by a rule rather than a list, so it stays correct as the catalogue changes. "Anything in a dark finish", not a spreadsheet of SKUs.'],
  ['Badge', 'A label on a product card — "Best Seller", "New" — applied by a rule rather than set per product.'],
  ['Product option', 'One buyable variation: a size, a finish, a colour. One product can have dozens; search indexes each, then groups them back into one card.'],
  ['Update now', 'Re-read the catalogue from source. Merchandising changes do not need it — they take effect on the next search.'],
];

const ROLES = [
  ['Search', 'Read-only. Can run searches through the API. This is the key that ships in your storefront.'],
  ['Analyst', 'Everything on the reporting screens, plus recommendations and history. Changes nothing.'],
  ['Merchandiser', 'Everything an analyst can do, plus arranging results, vocabulary, collections and badges.'],
  ['Admin', 'Everything, plus catalogue updates and API keys.'],
];

export const guide = {
  title: 'How to use this',
  subtitle: 'What the tool does, and the five jobs you will actually do with it',
  needs: 'search',

  async render(root) {
    root.innerHTML = `
      <div class="card guide__intro">
        <h2 class="card__title">What this is</h2>
        <p class="prose">
          This is the search on your storefront, and the controls for it. Everything a
          shopper types is recorded here, so the tool can tell you which searches are
          failing, suggest what to do about them, and let you change the results
          directly — <strong>without a developer and without a deploy</strong>.
        </p>
        <p class="prose">
          Most of it looks after itself. Results already reorder themselves based on what
          shoppers click, so the products people actually want drift upward on their own.
          The screens below are for the decisions that judgement, not arithmetic, should
          make.
        </p>
        <p class="prose">
          <strong>Nothing here is permanent.</strong> Every change is listed in History
          with who made it, and can be undone in one click.
        </p>
      </div>

      <nav class="guide__toc" aria-label="On this page">
        <span class="guide__toc-label">The five jobs</span>
        ${JOBS.map((j) => `<a href="#guide-${j.id}">${j.n}. ${esc(j.title)}</a>`).join('')}
      </nav>

      ${JOBS.map(job).join('')}

      <div class="card" id="guide-words">
        <div class="card__head">
          <h2 class="card__title">Words this tool uses</h2>
          <p class="card__hint">Every term that appears on a screen, in plain English</p>
        </div>
        <dl class="guide__glossary">
          ${GLOSSARY.map(([term, meaning]) => `
            <div>
              <dt>${esc(term)}</dt>
              <dd>${esc(meaning)}</dd>
            </div>`).join('')}
        </dl>
      </div>

      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Who can do what</h2>
          <p class="card__hint">
            The console shows only what your key allows — screens you cannot use are not
            there, rather than there and broken
          </p>
        </div>
        <dl class="guide__glossary">
          ${ROLES.map(([role, can]) => `
            <div>
              <dt>${esc(role)}</dt>
              <dd>${esc(can)}</dd>
            </div>`).join('')}
        </dl>
      </div>`;
  },
};

function job(j) {
  return `
    <section class="card guide__job" id="guide-${j.id}">
      <div class="guide__head">
        <span class="guide__n" aria-hidden="true">${j.n}</span>
        <div>
          <h2 class="card__title">${esc(j.title)}</h2>
          <p class="guide__where">${esc(j.where)}</p>
        </div>
      </div>

      <p class="prose">${j.lead}</p>

      <figure class="guide__figure">
        <img src="./guide/${j.shot}" alt="${esc(j.alt)}" loading="lazy" width="1320">
        <figcaption>${esc(j.where)}</figcaption>
      </figure>

      <ol class="guide__steps">
        ${j.steps.map((step) => `<li>${step}</li>`).join('')}
      </ol>

      <div class="guide__example">
        <p class="guide__example-title">${esc(j.example.title)}</p>
        <p>${j.example.body}</p>
      </div>
    </section>`;
}
