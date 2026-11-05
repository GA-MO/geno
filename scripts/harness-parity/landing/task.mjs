// The landing-page task both harnesses get, word for word: one brief from an empty folder, then one round of
// feedback in the same session. Neither text names a check.

export const TASK_ID = 'landing-beancraft';
export const WORKSPACE = 'beancraft';

// The brief follows UI-Bench prompt #21 (huggingface.co/datasets/AfterQuery/ui-bench), with the stack and motion asks added.
export const PROMPT = `Build a landing page for BeanCraft, a subscription that ships rotating single-origin coffee.
Explain roast profiles, sourcing, and delivery cadence. Include three plan cards with price per bag, with "Subscribe" linking to an external Stripe-hosted checkout. Add a roaster profile section, a brew guide PDF download link, and a shipping schedule. Add a "Pause anytime" explainer and an FAQ on freshness and grinding. No accounts or stored preferences on-site. Add a short sustainability statement covering farms, certifications, and packaging.
Vibe: warm and informative, pairing sensory cues with operational clarity.
One page, a single index.html with inline CSS and JS, no build step.
Hero: a full-bleed WebGL2 shader background (raw WebGL2, no three.js) that reacts to the pointer.
Use GSAP 3.12.5 and ScrollTrigger from cdnjs for section reveals and micro-interactions.
Respect prefers-reduced-motion. No scroll pinning or scroll-jacking.
No other external assets. It must look right at 375px and 1280px wide.`;

export const FEEDBACK = 'The hero motion feels stiff. At 375px the spacing between sections is uneven. The prices on the plan cards are hard to read. Fix these three and keep everything else as it is.';

/** The three feedback asks, as the judge of the second round names them. */
export const ASKS = { heroMotion: 'the hero motion no longer feels stiff', spacing375: 'at 375px the spacing between sections is even', prices: 'the prices on the plan cards are easy to read' };
