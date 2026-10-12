---
title: เสนองานแยกแล้วเริ่ม
description: ระหว่างทำงาน โมเดลเจองานอีกชิ้นที่ควรทำแยก จึงเรียก spawn_task ซึ่งไม่เริ่มอะไร แค่ขึ้นการ์ดข้อเสนอ ผู้ใช้กด Start แล้ว Geno เปิด lane กับ session ใหม่ให้งานนั้น
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - เปิด Geno ใน VS Code (editor บอก engine ว่าแสดงข้อเสนองานได้ โมเดลจึงมี `spawn_task`)
    - โมเดลกำลังแก้ bug ใน `src/date.ts` และเห็นว่า `src/time.ts` มีปัญหาแบบเดียวกัน
  trigger: >-
    โมเดลเสนองานแยกแทนการขยายงานปัจจุบัน
  covers: [wf.spinoff]
  related: [wf.lane-apply, wf.arena-best-of-n, bg.task-attention]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `spawn_task` ด้วยหัวข้อ "Fix the same leap-year bug in src/time.ts", สรุปสั้น และ prompt ที่เขียนให้ครบในตัว
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/spinoff.ts#SPAWN_TASK_TOOL
      emits: [tool_use, spawn_task]
      phase: calling-model

    - use: tool-call-opens

    - id: offer
      lane: tool
      at: executor
      do: >-
        `spawn_task` ไม่เริ่มอะไร `offerOf` ตรวจว่าไม่มีข้อเสนอที่เปิดอยู่หัวข้อเดียวกัน และข้อเสนอที่เปิดอยู่ไม่เกิน 10
        แล้วคืนผลที่มีข้อเสนอติดไปด้วย ข้อความถึงโมเดลขึ้นต้นด้วย `Suggested task_<8 หลัก> "Fix the same leap-year bug in src/time.ts".` และบอกว่า "nothing was started. Go on with the current task."
      ref: packages/core/src/spinoff.ts#offerOf
      emits: [offered]

    - use: tool-result-returns

    - id: card
      lane: panel
      at: rail
      alongside: true
      do: >-
        ขั้นของ `spawn_task` วาดเป็นการ์ดข้อเสนอในบทสนทนา และการ์ดเดียวกันขึ้นในแผง Tasks ใต้หัวข้อ "Suggested in this chat"
      sees: >-
        การ์ด "Suggested task" หัวข้อ สรุป prompt ที่พับไว้ และปุ่ม [Start] [Dismiss]
      ref: packages/extension/src/chat/spinoff-view.ts#spinoffCard

    - use: model-call

    - id: goes-on
      lane: model
      do: >-
        โมเดลทำ bug ใน `src/date.ts` ต่อจนจบ turn งานที่เสนอไม่ได้เข้ามาในบทสนทนานี้
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - id: decide
      lane: user
      do: ผู้ใช้อ่านการ์ด (ระหว่าง turn หรือหลังจบก็ได้)
      fork:
        ask: ผู้ใช้กดอะไร
        options:
          - id: start
            label: Start
            then: start

          - id: dismiss
            label: Dismiss
            steps:
              - lane: editor
                at: chat
                do: >-
                  `decideSpinoff` ส่ง `_gcode/spinoffs/dismiss`
                ref: "packages/extension/src/chat/chat.ts#\"private async decideSpinoff(method: typeof SPINOFF_START_METHOD | typeof SPINOFF_DISMISS_METHOD, id: string): Promise<void> {\""
                emits: [_gcode/spinoffs/dismiss]
              - lane: server
                at: sessions
                do: >-
                  engine บันทึกการตัดสิน `dismissed` ลง log ของแชตทันที ไม่ว่าจะมี turn รันหรือไม่ คำขอโมเดลครั้งถัดไปอ่านได้
                  การ์ดหายไป และ `spawn_task` หัวข้อเดิมเสนอใหม่ได้
                ref: "packages/engine/src/serve.ts#\"const decideSpinoff = async (sessionId: string\""
                emits: [spinoff, dismissed]
                end: { turn: none }

    - id: start
      lane: editor
      at: chat
      do: >-
        การ์ดขึ้น "Starting…" `decideSpinoff` ส่งคำขอ `_gcode/spinoffs/start` พร้อมโหมดเริ่มต้นของแชต
      ref: "packages/extension/src/chat/chat.ts#\"private async decideSpinoff(method: typeof SPINOFF_START_METHOD | typeof SPINOFF_DISMISS_METHOD, id: string): Promise<void> {\""
      emits: [_gcode/spinoffs/start]

    - id: lane
      lane: server
      at: sessions
      do: >-
        engine กันการกด Start ซ้ำ แล้ว `laneFor` สร้าง lane ใหม่ชื่อจากหัวข้อ และเปิด session ระดับบนสุดใน lane นั้นด้วย prompt ของข้อเสนอ
        session ใหม่ไม่ใช่ลูกของแชตนี้ ผลของมันไม่กลับมาที่แชตนี้
      ref: "packages/engine/src/serve.ts#\".onRequest(SPINOFF_START_METHOD, spinoffRequest, async ({ params }): Promise<SpinoffResponse> => {\""
      phase: starting

    - id: logged
      lane: server
      at: sessions
      do: >-
        engine บันทึกการตัดสิน `started` พร้อม session id และชื่อ lane ลง log ของแชต ครั้งหน้าโมเดลของแชตรู้ว่างานนี้เริ่มแล้ว
      ref: "packages/engine/src/serve.ts#\"const decideSpinoff = async (sessionId: string\""
      emits: [spinoff, started]

    - id: started
      lane: panel
      at: tasks
      do: >-
        การ์ดในบทสนทนาย่อเหลือบรรทัด Started และงานใหม่ขึ้นใน Working ของแผง Tasks พร้อมชื่อ lane
      sees: บรรทัด "Started Fix the same leap-year bug in src/time.ts" และงานใหม่ใน Tasks ที่บอก "Lane fix-the-same-leap-year..."
      ref: packages/extension/src/chat/spinoff-view.ts#spinoffCard
      end: { turn: continues }
---

`spawn_task` แยกการเสนอออกจากการเริ่ม: โมเดลเสนอได้ทุกเมื่อโดยไม่เสียเงินและไม่หลุดจากงานที่ทำอยู่
ผู้ใช้เป็นคนเดียวที่เริ่มงานนั้นได้ และงานเริ่มใน lane ของตัวเอง จึงไม่แตะไฟล์ที่แชตนี้กำลังแก้

สิ่งที่ควรสังเกต

- **ข้อเสนอไม่ซ้ำ** หัวข้อเดียวกับข้อเสนอที่เปิดอยู่ได้ error และมีข้อเสนอเปิดได้ไม่เกิน 10 อัน โมเดลถอนข้อเสนอของตัวเองได้ด้วย `dismiss_task`
- **ผลไม่กลับมา** งานที่เริ่มเป็น session ระดับบนสุดใน lane ผู้ใช้ตามงานในแผง Tasks และนำกลับด้วย Apply ในแผง Lanes
- **ต้องมี editor ที่แสดงข้อเสนอได้** engine ให้ `spawn_task` เฉพาะเมื่อ editor ที่ต่ออยู่บอกว่ารองรับ ใน CLI จึงไม่มี
