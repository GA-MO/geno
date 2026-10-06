/// <reference lib="dom" />
import type { ArenaRun, Variety } from '@g-code/core';
import { laneLetter, variantLabel, VARIETIES } from '@g-code/core/arena';
import {
  ARENA_STAGES,
  compareView,
  costBasis,
  costSentence,
  EMPTY_ARENA,
  graftLabel,
  hunkLines,
  raceRows,
  raceTurnOf,
  rankRows,
  RUN_BADGES,
  toggleGraft,
  VARIETY_LABELS,
  varietyOf,
  type ArenaFromView,
  type ArenaNotice,
  type ArenaPreview,
  type ArenaState,
  type CompareView,
  type GraftSelection,
  type RaceRow,
  type RankRow,
} from './arena-model.js';
import { h, icon, reconcile, type Keyed } from './dom.js';
import { helperDinos } from './helper-dino.js';
import type { Badge } from './lanes-model.js';
import { pane } from './lanes-panel.js';
import { motionGate } from './motion.js';

type Post = (message: ArenaFromView) => void;

const badge = ({ label, tone }: Badge, extra = ''): HTMLElement =>
  h('span', { class: `mcp-state tone-${tone} ${extra}`.trim() }, tone === 'busy' ? icon('loading', 'codicon-modifier-spin') : undefined, label);

const letterChip = (letter: string, extra = ''): HTMLElement => h('span', { class: `arena-letter ${extra}`.trim(), 'aria-hidden': 'true' }, letter);

const NOTICE_TONES: { readonly [T in ArenaNotice['tone']]: Badge['tone'] } = { busy: 'busy', ok: 'ok', failed: 'failed' };

function noticeLine(notice: ArenaNotice | undefined): HTMLElement | undefined {
  if (notice === undefined) return undefined;
  return h(
    'p',
    { class: `arena-notice tone-${NOTICE_TONES[notice.tone]}`, role: notice.tone === 'failed' ? 'alert' : 'status' },
    notice.tone === 'busy' ? icon('loading', 'codicon-modifier-spin') : icon(notice.tone === 'ok' ? 'check' : 'error'),
    h('span', {}, notice.text),
  );
}

function previewCard(preview: ArenaPreview, post: Post, close: () => void): HTMLElement {
  const cancel = h('button', { type: 'button', class: 'button small secondary', 'data-focus': 'arena-cancel', onclick: () => (post({ type: 'arena-cancel' }), close()) }, 'Cancel');
  if (preview.kind === 'invalid') {
    return h('section', { class: 'arena-card arena-preview', 'aria-label': 'Best of n' }, h('p', { class: 'arena-error', role: 'alert' }, preview.error), h('div', { class: 'lane-actions' }, cancel));
  }
  const { ask } = preview;
  const known = preview.kind === 'ready' || preview.kind === 'starting' ? preview : undefined;
  const variety = known === undefined ? ask.variety : varietyOf(ask, known.variants);
  const choose = (next: Variety) => post({ type: 'arena-preview', ask: { ...ask, variety: next } });
  return h(
    'section',
    { class: 'arena-card arena-preview', 'aria-label': `Best of ${ask.n}` },
    h('p', { class: 'arena-label' }, 'Task'),
    h('p', { class: 'arena-task' }, ask.task),
    h('p', { class: 'arena-label' }, `${ask.n} lanes`),
    known === undefined
      ? h('p', { class: 'arena-muted' }, preview.kind === 'failed' ? '' : 'Asking the engine…')
      : h(
          'ol',
          { class: 'arena-variants' },
          ...known.variants.map((variant, i) => h('li', { 'data-variant': String(i) }, letterChip(laneLetter(i)), h('span', {}, variantLabel(variant)))),
        ),
    h(
      'div',
      { class: 'arena-variety', role: 'radiogroup', 'aria-label': 'How the lanes differ' },
      ...VARIETIES.map((each) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: `arena-choice${each === variety ? ' chosen' : ''}`,
            'aria-checked': String(each === variety),
            'data-variety': each,
            'data-focus': `arena-variety:${each}`,
            disabled: preview.kind === 'starting',
            onclick: () => choose(each),
          },
          VARIETY_LABELS[each],
        ),
      ),
    ),
    preview.kind === 'failed'
      ? h('p', { class: 'arena-error', role: 'alert' }, preview.message)
      : h('p', { class: 'arena-cost', title: known === undefined ? '' : costBasis(known.preview) }, known === undefined ? 'Working out the cost…' : costSentence(known.preview)),
    h('p', { class: 'arena-muted' }, 'Each lane runs in its own copy of the repository, then the project check. A review ranks the lanes that pass. Nothing runs before Start.'),
    h(
      'div',
      { class: 'lane-actions' },
      h(
        'button',
        { type: 'button', class: 'button small', 'data-focus': 'arena-start', disabled: preview.kind !== 'ready', onclick: () => post({ type: 'arena-start', ask }) },
        preview.kind === 'starting' ? 'Starting…' : 'Start',
      ),
      cancel,
    ),
  );
}

function runHead(run: ArenaRun, extra?: HTMLElement): HTMLElement {
  return h('div', { class: 'arena-head' }, h('p', { class: 'arena-task', title: run.task }, run.task), h('div', { class: 'arena-head-row' }, badge(RUN_BADGES[run.status], 'arena-status'), h('span', { class: 'spacer' }), extra));
}

const STATE_ICONS: { readonly [T in Badge['tone']]: string } = { ok: 'pass-filled', failed: 'error', quiet: 'circle-slash', busy: 'loading', wait: 'question' };

function raceItem(row: RaceRow): HTMLElement {
  return h(
    'li',
    { class: 'race-row', 'data-lane': row.lane, 'data-status': row.state.label.toLowerCase() },
    h('div', { class: 'race-top' }, letterChip(row.letter), h('span', { class: 'race-label', title: row.label }, row.label), h('span', { class: 'spacer' }), badge(row.state, 'race-state')),
    h(
      'div',
      { class: 'race-track', role: 'progressbar', 'aria-label': `Lane ${row.letter}`, 'aria-valuemin': '0', 'aria-valuemax': '100' },
      h('span', { class: 'race-line', 'aria-hidden': 'true' }),
      h('span', { class: 'race-runner', 'data-helper': row.sessionId }, row.settled ? icon(STATE_ICONS[row.state.tone], `race-end tone-${row.state.tone}`) : undefined),
      h('span', { class: 'race-finish', 'aria-hidden': 'true' }, icon('flag')),
    ),
    (row.check !== undefined || row.cost !== undefined || row.turns !== undefined) &&
      h(
        'p',
        { class: 'lane-meta race-meta' },
        row.check !== undefined && badge(row.check, 'race-check'),
        row.turns !== undefined && h('span', { class: 'race-turns' }, row.turns),
        row.cost !== undefined && h('span', { class: 'lane-cost race-cost' }, row.cost),
      ),
  );
}

function raceCard(run: ArenaRun, notice: ArenaNotice | undefined, post: Post): HTMLElement {
  const running = run.lanes.some((lane) => lane.status === 'running');
  const stop = running
    ? h('button', { type: 'button', class: 'button small secondary', 'data-focus': 'arena-stop', title: 'Stop every running lane', onclick: () => post({ type: 'arena-stop', id: run.id }) }, 'Stop')
    : undefined;
  return h(
    'section',
    { class: 'arena-card arena-race', 'aria-label': 'The race' },
    runHead(run, stop),
    h('ol', { class: 'race-list', 'aria-label': 'Lanes' }, ...raceRows(run, Date.now()).map(raceItem)),
    run.status === 'ranking' && h('p', { class: 'arena-muted arena-ranking', role: 'status' }, 'The review is ranking the lanes that passed…'),
    noticeLine(notice),
  );
}

/** `lead` marks the review's best pick, whose Pick is the primary action. */
function rankItem(row: RankRow, run: ArenaRun, post: Post, lead: boolean): HTMLElement {
  return h(
    'li',
    { class: `rank-row${row.winner ? ' winner' : ''}`, 'data-lane': row.lane },
    h(
      'div',
      { class: 'race-top' },
      h('span', { class: 'rank-number', title: row.rank === null ? 'Not ranked' : `Rank ${row.rank}` }, row.rank === null ? '–' : String(row.rank)),
      letterChip(row.letter),
      h('span', { class: 'race-label', title: row.label }, row.label),
      h('span', { class: 'spacer' }),
      badge(row.state, 'rank-state'),
    ),
    row.reason !== null && h('p', { class: 'rank-reason' }, row.reason),
    row.checkTail !== undefined && h('details', { class: 'rank-check' }, h('summary', {}, 'Check output'), h('pre', {}, row.checkTail)),
    (row.cost !== undefined || row.pick) &&
      h(
        'div',
        { class: 'lane-actions' },
        row.pick &&
          h(
            'button',
            { type: 'button', class: `button small${lead ? '' : ' secondary'}`, 'data-action': 'pick', 'data-focus': `arena-pick:${row.lane}`, title: 'Make it the winner and apply it in the chat, for review', onclick: () => post({ type: 'arena-pick', id: run.id, lane: row.lane }) },
            `Pick ${row.letter}`,
          ),
        row.cost !== undefined && h('span', { class: 'lane-cost rank-cost' }, row.cost),
      ),
  );
}

function resultsCard(run: ArenaRun, notice: ArenaNotice | undefined, post: Post): HTMLElement {
  return h(
    'section',
    { class: 'arena-card arena-results', 'aria-label': 'The ranking' },
    runHead(run),
    run.summary !== null && run.summary !== '' && h('p', { class: 'arena-summary' }, run.summary),
    h('ol', { class: 'rank-list', 'aria-label': 'Lanes, best first' }, ...rankRows(run).map((row, i, rows) => rankItem(row, run, post, row.pick && rows.findIndex((r) => r.pick) === i))),
    noticeLine(notice),
  );
}

function hunkItem(hunk: CompareView['files'][number]['cells'][number]['hunks'][number], selected: GraftSelection, onToggle: () => void): HTMLElement {
  const line = `Line ${hunk.startLine}`;
  const checked = selected?.lane === hunk.lane && selected.hunks.includes(hunk.id);
  return h(
    'div',
    { class: `compare-hunk${hunk.graftable ? ' graftable' : ''}`, 'data-hunk': hunk.id },
    hunk.graftable
      ? h('label', { class: 'compare-pick' }, h('input', { type: 'checkbox', checked, 'data-focus': `graft:${hunk.id}`, onchange: onToggle }), h('span', {}, line))
      : h('span', { class: 'compare-line' }, line),
    h('pre', { class: 'compare-lines' }, ...hunkLines(hunk).map(({ sign, text }) => h('span', { class: sign === '-' ? 'del' : 'add' }, `${sign} ${text}\n`))),
  );
}

function compareCard(compare: CompareView, post: Post, local: { focus: (lane: string) => void; toggle: (lane: string, hunk: string) => void; close: () => void }): HTMLElement {
  const letterOf = (lane: string) => compare.columns.find((c) => c.lane === lane)?.letter;
  const graft = compare.winner !== null;
  return h(
    'section',
    { class: 'arena-card arena-compare', 'aria-label': 'Changes side by side' },
    h(
      'div',
      { class: 'compare-inner', 'data-lanes': String(compare.columns.length) },
      h('h3', { class: 'arena-label' }, 'Changes'),
      h(
        'div',
        { class: 'compare-switch', role: 'tablist', 'aria-label': 'Lane to show' },
        ...compare.columns.map((column) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              class: `compare-tab${column.lane === compare.focus ? ' chosen' : ''}`,
              'aria-selected': String(column.lane === compare.focus),
              'data-lane': column.lane,
              'data-focus': `compare-tab:${column.lane}`,
              title: column.label,
              onclick: () => local.focus(column.lane),
            },
            column.letter,
            column.rank !== null && h('span', { class: 'compare-rank' }, `#${column.rank}`),
            column.winner && icon('star-full', 'compare-star'),
          ),
        ),
      ),
      h(
        'div',
        { class: 'compare-columns', 'aria-hidden': 'true' },
        ...compare.columns.map((column) =>
          h('div', { class: `compare-column${column.lane === compare.focus ? ' focused' : ''}`, 'data-lane': column.lane }, letterChip(column.letter), h('span', { class: 'race-label' }, column.label), column.rank !== null && h('span', { class: 'compare-rank' }, `#${column.rank}`)),
        ),
      ),
      compare.files.length === 0 && h('p', { class: 'arena-muted' }, 'No lane changed a file.'),
      ...compare.files.map((file) =>
        h(
          'div',
          { class: 'compare-file', 'data-path': file.path },
          h('p', { class: 'compare-path', title: file.path }, icon('file'), h('span', {}, file.path)),
          h(
            'div',
            { class: 'compare-cells' },
            ...file.cells.map((cell) =>
              h(
                'div',
                { class: `compare-cell${cell.lane === compare.focus ? ' focused' : ''}`, 'data-lane': cell.lane },
                h('p', { class: 'compare-cell-head' }, `Lane ${letterOf(cell.lane) ?? ''}`),
                cell.hunks.length === 0
                  ? h('p', { class: 'arena-muted compare-none' }, 'No change')
                  : h('div', { class: 'compare-hunks' }, ...cell.hunks.map((hunk) => hunkItem(hunk, compare.selected, () => local.toggle(hunk.lane, hunk.id)))),
              ),
            ),
          ),
        ),
      ),
      graft &&
        h(
          'div',
          { class: 'compare-graft' },
          h(
            'button',
            {
              type: 'button',
              class: 'button small',
              'data-action': 'graft',
              'data-focus': 'arena-graft',
              disabled: compare.selected === undefined,
              onclick: () => {
                if (compare.selected === undefined) return;
                post({ type: 'arena-graft', id: compare.id, lane: compare.selected.lane, hunks: compare.selected.hunks });
                local.close();
              },
            },
            graftLabel(compare.selected, compare.selected === undefined ? undefined : letterOf(compare.selected.lane)),
          ),
          h('span', { class: 'arena-muted' }, 'One lane at a time. Each lands in the chat for review.'),
        ),
    ),
  );
}

/**
 * The Arena pane: the preview before a best-of-n starts, its race, then the ranking and the compare with Pick and
 * Graft. `saw` hears of each run the pane shows, which counts as the user opening it.
 */
export function arenaPanel(post: Post, onToggle: (open: boolean) => void, saw: (id: string) => void) {
  let state: ArenaState = EMPTY_ARENA;
  /** What only this view decides, per run: the lane a narrow compare shows, and the hunks ticked for a graft. */
  const focus = new Map<string, string>();
  const selection = new Map<string, GraftSelection>();
  let ticking: ReturnType<typeof setInterval> | undefined;
  const dinos = helperDinos();
  const gate = motionGate((motion) => dinos.setMotion(motion));
  dinos.setMotion(gate.motion());
  const content = h('div', { class: 'arena-body' });
  const frame = pane('Best of n', 'Best of n', (open) => {
    onToggle(open);
    if (!open) render();
  }, () => render());
  frame.element.classList.add('arena');
  frame.body.append(content);
  const heading = frame.element.querySelector<HTMLElement>('.history-heading')!;

  const shownRun = (): ArenaRun | undefined => state.runs.find((run) => run.id === state.shown) ?? state.runs[0];

  function render(): void {
    const run = frame.isOpen() && state.preview === undefined ? shownRun() : undefined;
    const racing = run !== undefined && ARENA_STAGES[run.status] === 'race';
    if (!frame.isOpen()) {
      stopTicking();
      dinos.show([]);
      gate.set('shown', false);
      return;
    }
    const was = (document.activeElement as HTMLElement | null)?.dataset['focus'];
    heading.textContent = state.preview !== undefined && state.preview.kind !== 'invalid' ? `Best of ${state.preview.ask.n}` : run === undefined ? 'Best of n' : `Best of ${run.lanes.length}`;
    const items: Keyed[] = [];
    if (state.preview !== undefined) {
      const preview = state.preview;
      items.push({ key: 'preview', deps: [JSON.stringify(preview)], build: () => previewCard(preview, post, frame.close) });
    } else if (run === undefined) {
      items.push({ key: 'none', deps: [], build: () => h('p', { class: 'history-note lanes-note' }, 'No best-of-n runs yet. Type /best-of-n 3 and a task to run it in three lanes at once, then pick the best.') });
    } else {
      const notice = state.notices[run.id];
      if (racing) items.push({ key: `race:${run.id}`, deps: [JSON.stringify(run), JSON.stringify(notice)], build: () => raceCard(run, notice, post) });
      else {
        items.push({ key: `results:${run.id}`, deps: [JSON.stringify(run), JSON.stringify(notice)], build: () => resultsCard(run, notice, post) });
        const diffs = state.diffs[run.id];
        const compare = diffs === undefined ? undefined : compareView(run, diffs, focus.get(run.id), selection.get(run.id));
        items.push(
          compare === undefined
            ? { key: `compare:${run.id}`, deps: ['loading'], build: () => h('p', { class: 'arena-muted arena-compare-loading' }, 'Reading each lane’s changes…') }
            : {
                key: `compare:${run.id}`,
                deps: [JSON.stringify(compare)],
                build: () =>
                  compareCard(compare, post, {
                    focus: (lane) => {
                      focus.set(run.id, lane);
                      render();
                    },
                    toggle: (lane, hunk) => {
                      selection.set(run.id, toggleGraft(compare.selected, lane, hunk));
                      render();
                    },
                    close: () => {
                      selection.delete(run.id);
                      frame.close();
                    },
                  }),
              },
        );
      }
    }
    reconcile(content, items);
    if (run !== undefined) saw(run.id);
    if (was !== undefined && !document.activeElement?.isConnected) content.querySelector<HTMLElement>(`[data-focus="${CSS.escape(was)}"]`)?.focus();
    moveRunners(run);
    dinos.show(racing ? run.lanes.map((lane) => ({ id: lane.sessionId, turn: raceTurnOf(lane, Date.parse(run.createdAt)) })) : []);
    gate.set('shown', racing && dinos.active());
    if (racing) ticking ??= setInterval(() => moveRunners(shownRun()), 1000);
    else stopTicking();
  }

  function stopTicking(): void {
    clearInterval(ticking);
    ticking = undefined;
  }

  /** Places each runner along its track without rebuilding the row, so the dino and the keyboard stay put. */
  function moveRunners(run: ArenaRun | undefined): void {
    if (run === undefined) return;
    for (const row of raceRows(run, Date.now())) {
      const item = content.querySelector<HTMLElement>(`.race-row[data-lane="${CSS.escape(row.lane)}"]`);
      item?.style.setProperty('--progress', String(row.progress));
      item?.querySelector('.race-track')?.setAttribute('aria-valuenow', String(Math.round(row.progress * 100)));
    }
  }

  return {
    element: frame.element,
    isOpen: frame.isOpen,
    open: frame.open,
    close: frame.close,
    gate,
    listed(next: ArenaState): void {
      state = next;
      render();
    },
  };
}
