/** The History search fixture's sessions, shared by the suite inside VS Code and the test that logs them before launch. */
export const FILES = { 'a.ts': 'export const a = 1;\n' } as const;

/** One turn: what the user asked and what the assistant answered. */
export type FixtureTurn = { readonly prompt: string; readonly answer: string };

const filler = (n: number): FixtureTurn => ({
  prompt: `Step ${n}: tidy the shop module number ${n}`,
  answer: `Tidied module ${n}. ${'The code reads better now and the tests still pass. '.repeat(6)}`,
});

/** The turn of DATABASE that holds the decision, counted from 1. */
export const DECISION_TURN = 9;
export const DECISION = 'For the orders database we decided on Postgres 17 with the pg driver, not MongoDB, because orders need transactions.';

/** A long session, so the turn a search opens at sits mid-scroll. */
export const DATABASE = {
  id: 'shop-database',
  turns: Array.from({ length: 12 }, (_, i): FixtureTurn => (i + 1 === DECISION_TURN ? { prompt: 'Which database should the orders use?', answer: DECISION } : filler(i + 1))),
} as const;

export const THAI = {
  id: 'thai-queue',
  turns: [
    { prompt: 'คิวงานส่งอีเมลควรใช้อะไรดี', answer: 'เราตัดสินใจใช้ Redis streams สำหรับคิวส่งอีเมล เพราะทีมใช้ Redis อยู่แล้ว' },
    { prompt: 'ขอบคุณครับ', answer: 'ยินดีครับ' },
  ],
} as const;

export const OTHER = { id: 'readme-tidy', turns: [{ prompt: 'Tidy the README', answer: 'The README is tidy.' }] } as const;

export const SESSIONS = [DATABASE, THAI, OTHER] as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
