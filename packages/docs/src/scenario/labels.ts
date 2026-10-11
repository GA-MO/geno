import type { TurnEnd } from './model.js';
import type { Party, Phase } from './schema.js';

export const PARTY_LABELS: Readonly<Record<Party, string>> = { user: 'ผู้ใช้', ai: 'AI', harness: 'harness', outside: 'ระบบภายนอก' };

export const WHOSE_MOVE: Readonly<Record<Party, string>> = {
  user: 'ตาของผู้ใช้',
  ai: 'ตาของ AI',
  harness: 'ตาของ harness',
  outside: 'ระบบภายนอกตอบ',
};

export const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  idle: 'ยังไม่มี turn',
  starting: 'กำลังเริ่ม turn',
  'calling-model': 'กำลังเรียกโมเดล',
  'running-tools': 'กำลังรันเครื่องมือ',
  'waiting-user': 'รอผู้ใช้ตอบ',
  'waiting-retry': 'รอแล้วลองใหม่',
  compacting: 'กำลังย่อ context',
  held: 'รอรายงานจากเอเจนต์ลูก',
  ending: 'กำลังจบ turn',
};

export const TURN_END_LABELS: Readonly<Record<TurnEnd['turn'], string>> = {
  done: 'turn จบแล้ว',
  failed: 'turn ล้มเหลว',
  stopped: 'turn ถูกหยุด',
  waits: 'turn พักรอ',
  continues: 'turn ยังทำงานต่อ',
  none: 'ไม่มี turn',
};

export const endText = (end: TurnEnd): string => (end.reason === undefined ? end.turn : `${end.turn} (${end.reason})`);

export function codeSegments(text: string): { readonly code: boolean; readonly text: string }[] {
  return text
    .split('`')
    .map((part, i) => ({ code: i % 2 === 1, text: part }))
    .filter((segment) => segment.text !== '');
}
