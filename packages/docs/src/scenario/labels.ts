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

export const PHASE_MEANINGS: Readonly<Record<Phase, string>> = {
  idle: 'ยังไม่มี turn ใดทำงานอยู่',
  starting: 'เซิร์ฟเวอร์รับ prompt แล้ว และกำลังเปิด run',
  'calling-model': 'กำลังสร้าง ส่ง หรือสตรีมคำขอไปยังโมเดล',
  'running-tools': 'ชุดของ call กำลังรัน รวมการตรวจ policy ก่อนแต่ละ call',
  'waiting-user': 'การ์ดขออนุญาตหรือคำถาม ask_user เปิดรอผู้ใช้อยู่',
  'waiting-retry': 'รอ backoff ของ gateway รอเน็ตกลับมา หรือรอพ้น rate limit',
  compacting: 'context ถึง 80% แล้ว engine กำลังสรุปประวัติเก่าให้สั้นลงก่อนเรียกโมเดล',
  held: 'turn รอรายงานจากเอเจนต์ลูกที่ทำงานเบื้องหลัง',
  ending: 'ลูปบอกว่าเสร็จแล้ว กำลังรัน Stop hook บันทึก usage และปิด task',
};

export const TURN_END_LABELS: Readonly<Record<TurnEnd['turn'], string>> = {
  done: 'turn จบแล้ว',
  failed: 'turn ล้มเหลว',
  stopped: 'turn ถูกหยุด',
  waits: 'turn พักรอ',
  continues: 'turn ยังทำงานต่อ',
  none: 'ไม่มี turn',
};

export const TURN_END_MEANINGS: Readonly<Record<TurnEnd['turn'], string>> = {
  done: 'task จบแบบเสร็จ reason คือ DoneReason ของลูป (เช่น end_turn)',
  failed: 'task จบแบบล้มเหลว: ครบเพดานรอบหรืองบ โมเดลปฏิเสธ หรือเกิด error',
  stopped: 'ผู้ใช้หรือ engine หยุด turn นี้',
  waits: 'turn พักรอสิ่งที่อยู่นอก turn (เอเจนต์ลูกที่ถูก hold หรือการปลุกที่หยุดไว้)',
  continues: 'สถานการณ์จบตรงนี้ แต่ turn ยังทำงานต่อ',
  none: 'สถานการณ์นี้ไม่มี turn (เช่น ตั้ง API key หรือ Tab)',
};

export const endText = (end: TurnEnd): string => (end.reason === undefined ? end.turn : `${end.turn} (${end.reason})`);

export function codeSegments(text: string): { readonly code: boolean; readonly text: string }[] {
  return text
    .split('`')
    .map((part, i) => ({ code: i % 2 === 1, text: part }))
    .filter((segment) => segment.text !== '');
}
