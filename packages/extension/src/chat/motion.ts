/// <reference lib="dom" />

/**
 * Whether Noodle may move. Moving needs every pause condition met; a still condition, reduced motion or a
 * high contrast theme, holds it in its idle pose instead.
 */
export type Motion = 'moving' | 'paused' | 'still';

const PAUSES = ['shown', 'visible', 'focused'] as const;
const STILLS = ['reducedMotion', 'highContrast'] as const;
export type Condition = (typeof PAUSES)[number] | (typeof STILLS)[number];

export function motionOf(state: Readonly<Record<Condition, boolean>>): Motion {
  if (STILLS.some((still) => state[still])) return 'still';
  return PAUSES.every((pause) => state[pause]) ? 'moving' : 'paused';
}

/** Watches the page for what decides motion, and tells `onChange` each time the answer changes. */
export function motionGate(onChange: (motion: Motion) => void) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const contrast = () => ['vscode-high-contrast', 'vscode-high-contrast-light'].some((name) => document.body.classList.contains(name));
  const state: Record<Condition, boolean> = {
    shown: false,
    visible: document.visibilityState === 'visible',
    focused: true,
    reducedMotion: reduced.matches,
    highContrast: contrast(),
  };
  let last = motionOf(state);

  function set(condition: Condition, value: boolean): void {
    state[condition] = value;
    const now = motionOf(state);
    if (now === last) return;
    last = now;
    onChange(now);
  }

  reduced.addEventListener('change', () => set('reducedMotion', reduced.matches));
  document.addEventListener('visibilitychange', () => set('visible', document.visibilityState === 'visible'));
  new MutationObserver(() => set('highContrast', contrast())).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  return { set, motion: () => last };
}
