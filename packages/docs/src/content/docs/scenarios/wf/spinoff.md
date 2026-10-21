---
title: เสนองานแยกแล้วเริ่ม
description: ระหว่างทำงาน model เจองานอีกชิ้นที่ควรทำแยก จึงเรียก spawn_task ซึ่งไม่เริ่มอะไร แค่ขึ้นการ์ดข้อเสนอ ผู้ใช้กด Start แล้ว Geno เปิด lane กับ session ใหม่ให้งานนั้น
scenario:
  surface: vscode
  given:
    - เปิด Geno ใน VS Code (editor บอก engine ว่าแสดงข้อเสนองานได้ model จึงมี `spawn_task`)
    - model กำลังแก้ bug ใน `src/date.ts` และเห็นว่า `src/time.ts` มีปัญหาแบบเดียวกัน
  trigger: >-
    model เสนองานแยกแทนการขยายงานปัจจุบัน
  covers: [wf.spinoff]
  related: [wf.lane-apply, wf.arena-best-of-n, bg.task-attention]
  steps:
    - id: wants
      beat:
        title: Model เสนองานแยก
        text: >-
          ระหว่างแก้ bug ใน `src/date.ts` model เห็นว่า `src/time.ts` มีปัญหาแบบเดียวกัน แทนที่จะขยายงาน มันเรียก tool `spawn_task`
          ซึ่งเสนองานแยกให้คุณ พร้อมหัวข้อ สรุป และ prompt ที่ครบในตัวจนคนอื่นทำต่อได้โดยไม่ต้องอ่านแชตนี้
          `spawn_task` เป็น deferred tool คือ Geno ส่งแค่ชื่อไปก่อน model จึงโหลดนิยามด้วย `tool_search` ก่อนเรียก
          การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ดู `input` ที่ไฮไลต์ มี `title` `tldr` (สรุปสั้น) และ `prompt`
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/wf-spinoff.jsonl#line=10
          select: messages[7].content
          highlight: ['[1].input']
      lane: model
      do: >-
        model ขอเรียก `spawn_task` ด้วยหัวข้อ "Fix the same leap-year bug in src/time.ts", สรุปสั้น และ prompt ที่เขียนให้ครบในตัว
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/spinoff.ts#SPAWN_TASK_TOOL
      emits: [tool_use, spawn_task]
      phase: calling-model

    - use: tool-call-opens

    - id: offer
      beat:
        title: Geno ไม่เริ่มอะไร แค่เก็บข้อเสนอ
        text: >-
          Geno ตรวจว่าไม่มีข้อเสนอหัวข้อเดียวกันเปิดอยู่ และข้อเสนอที่เปิดอยู่ยังไม่ถึง 10 แล้วเขียนข้อความผลพร้อมข้อเสนอนั้นไว้ใน log
          ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร
        from: engine
        to: engine
      lane: tool
      at: executor
      do: >-
        `spawn_task` ไม่เริ่มอะไร `offerOf` ตรวจว่าไม่มีข้อเสนอที่เปิดอยู่หัวข้อเดียวกัน และข้อเสนอที่เปิดอยู่ยังไม่ถึง 10
        แล้วคืนผลที่มีข้อเสนอติดไปด้วย ข้อความถึง model ขึ้นต้นด้วย `Suggested task_<8 หลัก> "Fix the same leap-year bug in src/time.ts".` และบอกว่า "nothing was started. Go on with the current task."
      ref: packages/core/src/spinoff.ts#offerOf
      emits: [offered]

    - use: tool-result-returns
      beat:
        title: แชตขึ้นการ์ดข้อเสนอ
        text: >-
          ขั้นของ `spawn_task` วาดเป็นการ์ดในบทสนทนา การ์ดเดียวกันขึ้นในแผง Tasks (แผงที่แสดงงานของทุกแชต) ใต้ "Suggested in this chat"
        from: panel
        to: you
        sees: การ์ด "Suggested task" หัวข้อ สรุป prompt ที่พับไว้ และปุ่ม [Start] [Dismiss]

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
      beat:
        title: Model ทำงานเดิมต่อ
        text: >-
          model แก้ `src/date.ts` ต่อจนจบ turn งานที่เสนอไม่เข้ามาในบทสนทนานี้
          การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน แท็บแรกคือ call ถัดไปของ model หลังได้ผลของ `spawn_task` ดู `input` ที่ไฮไลต์ model แก้ `src/date.ts` ไม่ใช่ `src/time.ts`
          แท็บสองคือ event ท้าย stream ของคำตอบสุดท้าย `stop_reason: end_turn` คือ model จบ turn
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/wf-spinoff.jsonl#line=12
            select: messages[9].content
            highlight: ['[1].input']
          - kind: payload
            source: packages/docs/src/data/recorded/wf-spinoff.jsonl#line=13
            select: '[-2]'
            highlight: [data.delta.stop_reason]
      lane: model
      do: >-
        model ทำ bug ใน `src/date.ts` ต่อจนจบ turn งานที่เสนอไม่ได้เข้ามาในบทสนทนานี้
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - id: decide
      beat:
        title: คุณอ่านการ์ด
        text: คุณตัดสินได้ทั้งระหว่าง turn และหลังจบ
        from: panel
        to: you
        ask: คุณกดอะไร
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
                beat:
                  title: คุณกด Dismiss
                  text: Geno จดว่าคุณปฏิเสธลง log ของแชตทันที บรรทัดนี้อยู่นอกบทสนทนา คำขอครั้งถัดไปของ model จึงไม่มีมัน model รู้ก็ต่อเมื่อเรียก `dismiss_task` กับข้อเสนอนี้ แล้วได้คำตอบว่าคุณปฏิเสธไปแล้ว การ์ดหายไป และ model เสนอหัวข้อเดิมใหม่ได้
                  from: you
                  to: panel
                  end: ข้อเสนอหายไป
                at: chat
                do: >-
                  `decideSpinoff` ส่ง `_gcode/spinoffs/dismiss`
                ref: "packages/extension/src/chat/chat.ts#\"private async decideSpinoff(method: typeof SPINOFF_START_METHOD | typeof SPINOFF_DISMISS_METHOD, id: string): Promise<void> {\""
                emits: [_gcode/spinoffs/dismiss]
              - lane: server
                at: sessions
                do: >-
                  engine บันทึกการตัดสิน `dismissed` ลง log ของแชตทันที ไม่ว่าจะมี turn รันหรือไม่ event `spinoff` อยู่นอกบทสนทนา
                  (`IN_CONVERSATION.spinoff = false`) คำขอ model จึงไม่มีมัน tool ของข้อเสนออ่าน log ใหม่ทุกครั้งที่ถูกเรียก
                  `dismiss_task` กับ id นี้จึงได้ "the user already dismissed it"
                  การ์ดหายไป และ `spawn_task` หัวข้อเดิมเสนอใหม่ได้
                ref: "packages/engine/src/serve.ts#\"const decideSpinoff = async (sessionId: string\""
                emits: [spinoff, dismissed]
                end: { turn: none }

    - id: start
      beat:
        title: คุณกด Start
        text: การ์ดขึ้น "Starting…" แชตขอให้ engine เริ่มงาน
        from: you
        to: panel
      lane: editor
      at: chat
      do: >-
        การ์ดขึ้น "Starting…" `decideSpinoff` ส่งคำขอ `_gcode/spinoffs/start` พร้อมโหมดเริ่มต้นของแชต
      ref: "packages/extension/src/chat/chat.ts#\"private async decideSpinoff(method: typeof SPINOFF_START_METHOD | typeof SPINOFF_DISMISS_METHOD, id: string): Promise<void> {\""
      emits: [_gcode/spinoffs/start]

    - id: lane
      beat:
        title: Geno เปิด lane และ session ใหม่
        text: >-
          Geno กันการกด Start ซ้ำ แล้วสร้าง lane ใหม่ชื่อตามหัวข้อ lane คือสำเนาของ repo ในโฟลเดอร์แยก (git worktree) บน branch
          ของตัวเอง งานใหม่จึงไม่แตะไฟล์ที่แชตนี้กำลังแก้ Geno เปิด session ใน lane นั้นด้วย prompt ของข้อเสนอ session ใหม่เป็นแชตแยก
          ไม่ใช่ subagent (session ลูกที่รายงานกลับหาแม่) ผลของมันจึงไม่กลับมาที่แชตนี้
        from: engine
        to: engine
      lane: server
      at: sessions
      do: >-
        engine กันการกด Start ซ้ำ แล้ว `laneFor` สร้าง lane ใหม่ชื่อจากหัวข้อ และเปิด session ระดับบนสุดใน lane นั้นด้วย prompt ของข้อเสนอ
        session ใหม่ไม่ใช่ลูกของแชตนี้ ผลของมันไม่กลับมาที่แชตนี้
      ref: "packages/engine/src/serve.ts#\".onRequest(SPINOFF_START_METHOD, spinoffRequest, async ({ params }): Promise<SpinoffResponse> => {\""
      phase: starting

    - id: logged
      beat:
        title: การ์ดย่อเหลือ Started
        text: Geno จดลง log ของแชตว่างานเริ่มแล้ว บรรทัดนี้อยู่นอกบทสนทนา model ของแชตจึงไม่เห็นมันในคำขอถัดไป จะรู้ก็ต่อเมื่อเรียก `dismiss_task` กับข้อเสนอนี้ แล้วได้คำตอบว่าคุณเริ่มงานไปแล้ว งานใหม่ขึ้นใน Working ของแผง Tasks
        from: engine
        to: panel
        sees: บรรทัด "Started Fix the same leap-year bug in src/time.ts" และงานใหม่ใน Tasks ที่บอก "Lane fix-the-same-leap-year..."
        end: งานใหม่รันใน lane
      lane: server
      at: sessions
      do: >-
        engine บันทึกการตัดสิน `started` พร้อม session id และชื่อ lane ลง log ของแชต event นี้ไม่เข้าบทสนทนา tool ของข้อเสนออ่าน log นี้ทุกครั้งที่ถูกเรียก `dismiss_task` กับ id นี้จึงได้ "the user already started it as a task in lane ..."
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

`spawn_task` แยกการเสนอออกจากการเริ่ม: model เสนอได้ทุกเมื่อโดยไม่เสียเงินและไม่หลุดจากงานที่ทำอยู่
ผู้ใช้เป็นคนเดียวที่เริ่มงานนั้นได้ และงานเริ่มใน lane ของตัวเอง จึงไม่แตะไฟล์ที่แชตนี้กำลังแก้

สิ่งที่ควรสังเกต

- **ข้อเสนอไม่ซ้ำ** หัวข้อเดียวกับข้อเสนอที่เปิดอยู่ได้ error และมีข้อเสนอเปิดได้ไม่เกิน 10 อัน model ถอนข้อเสนอของตัวเองได้ด้วย `dismiss_task`
- **ผลไม่กลับมา** งานที่เริ่มเป็น session ระดับบนสุดใน lane ผู้ใช้ตามงานในแผง Tasks และนำกลับด้วย Apply ในแผง Lanes
- **ต้องมี editor ที่แสดงข้อเสนอได้** engine ให้ `spawn_task` เฉพาะเมื่อ editor ที่ต่ออยู่บอกว่ารองรับ ใน CLI จึงไม่มี
