---
title: UserPromptSubmit บล็อกหรือเพิ่มบริบท
description: hook ที่ตั้งไว้ได้อ่าน prompt ก่อนโมเดล ถ้าบล็อก prompt ไม่ถึงโมเดลและ turn จบแบบ failed ถ้าพิมพ์ข้อความออกมา ข้อความนั้นไปกับ prompt
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว มี UserPromptSubmit hook ใน `.claude/settings.json` ซึ่งรันสคริปต์ `check-prompt.sh`
    - สคริปต์บล็อก prompt ที่มีสิ่งที่หน้าตาเหมือน API key และพิมพ์ชื่อ branch ปัจจุบันออกมาสำหรับ prompt อื่น
  trigger: >-
    ผู้ใช้ส่ง prompt ในแผงแชต
  covers: [hook.user-prompt-submit]
  related: [hook.pretooluse-deny, hook.stop-keeps-going, hook.project-untrusted, turn.text-answer]
  steps:
    - use: prompt-starts-turn

    - id: run
      lane: policy
      at: hooks
      do: >-
        `HookSessions.userPromptSubmit` รันทุก hook ของเหตุการณ์นี้ ส่ง JSON ที่มี `prompt` ทาง stdin
        แล้ว `promptDecision` รวมผล: hook ใดบล็อกก็บล็อกทั้งหมด ไม่เช่นนั้นข้อความของทุก hook ไปกับ prompt
      ref: packages/engine/src/hooks.ts#HookSessions.userPromptSubmit
      emits: [UserPromptSubmit]
      fork:
        ask: hook ตอบอะไร
        options:
          - id: block
            label: บล็อก (exit 2)
            steps:
              - lane: policy
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 2 และเขียนเหตุผลลง stderr ว่า "prompt มีสิ่งที่หน้าตาเหมือน API key"
                  (JSON `decision: "block"` หรือ `continue: false` ได้ผลเดียวกัน) `promptDecision` จึงได้ `block`
                ref: packages/core/src/hooks.ts#promptDecision
                emits: [block]
              - lane: loop
                at: drive
                do: >-
                  `submitted()` บันทึก event `error` ชนิด `blocked`: "A UserPromptSubmit hook blocked this prompt,
                  so the model did not see it: prompt มีสิ่งที่หน้าตาเหมือน API key" ไม่มีการเรียกโมเดล
                ref: packages/engine/src/drive.ts#submitted
                emits: [blocked]
              - lane: server
                at: updates
                do: >-
                  `errorUpdate` ส่ง `agent_message_chunk` พร้อม `TURN_ERROR_META` ชนิด `blocked`
                ref: packages/engine/src/session-replay.ts#errorUpdate
                emits: [agent_message_chunk, TURN_ERROR_META]
              - lane: editor
                at: chat
                alongside: true
                do: >-
                  `agentChunkAction` แปลงเป็น action `error`
                ref: packages/extension/src/chat/compact-host.ts#agentChunkAction
              - lane: panel
                at: rail
                alongside: true
                do: ใต้ข้อความของผู้ใช้ขึ้นแถบ error สีแดง
                sees: >-
                  "A UserPromptSubmit hook blocked this prompt, so the model did not see it: prompt มีสิ่งที่หน้าตาเหมือน API key"
                ref: packages/extension/src/chat/render.ts#errorBlock
              - lane: loop
                at: step
                do: >-
                  `loopStep` เห็น error ล่าสุด `ERROR_REASON` แปลง `blocked` เป็น `done(error)` Stop hook ไม่ทำงาน
                  และ `blocked` เป็นชนิดที่ทิ้ง prompt: ข้อความถัดไปของผู้ใช้จะไม่พา prompt นี้ไปด้วย
                ref: packages/core/src/session.ts#KEEPS_PENDING_PROMPT
                emits: [error]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `runTurn` ใช้ `TURN_ENDS.error`: `stopReason: end_turn` กับงานที่จบแบบ `failed`
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META, failed]
              - lane: editor
                at: chat
                do: >-
                  `turnEndOf` อ่าน `_meta` ได้ `failed` แล้ว `prompt()` ส่ง action `turn-end`
                ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status, usage: usageOf(response)\""
                emits: [turn-end]
              - lane: panel
                at: rail
                do: >-
                  หัวข้อเป็น "failed after ..." ไม่มีประกาศ Continue หรือ Retry เพราะ turn มีแถบ error แล้ว
                sees: หัวข้อ "failed after 1s" และปุ่ม Send กลับมา
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed, reason: error }

          - id: notes
            label: พิมพ์ข้อความ (exit 0)
            steps:
              - lane: policy
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 0 และพิมพ์ "branch: feat/login" ลง stdout UserPromptSubmit เป็นเหตุการณ์ที่ stdout
                  นับเป็นบริบท ข้อความนี้จึงเป็นโน้ตของ hook (JSON `additionalContext` ก็ได้ผลเดียวกัน)
                ref: packages/core/src/hooks.ts#promptDecision
              - lane: loop
                at: drive
                do: >-
                  `submitted()` บันทึก event `hook-context` ของ `UserPromptSubmit` ผู้ใช้ไม่เห็นโน้ตนี้ในแผงแชต
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'hook-context', seq: nextSeq(events), at, event: 'UserPromptSubmit'\""
                emits: [hook-context]
              - use: model-call
              - lane: model
                do: >-
                  โมเดลได้ข้อความของผู้ใช้ตามด้วยโน้ต "[Geno] UserPromptSubmit hook success: branch: feat/login"
                  ในข้อความผู้ใช้เดียวกัน แล้วตอบโดยรู้ว่าอยู่ branch ไหน
                ref: packages/core/src/hooks.ts#hookNoteText
                end: { turn: continues }
---

UserPromptSubmit เป็น hook ตัวเดียวที่ทำงานก่อนโมเดลเห็นอะไรเลย และทำงานเฉพาะกับ prompt ที่ผู้ใช้พิมพ์
ข้อความ steer turn ที่ถูกปลุก และการ resume ไม่ผ่าน hook นี้ (`isTyped`)

สิ่งที่ควรสังเกต

- **บล็อกแล้ว prompt หายจากบทสนทนาของโมเดล** `KEEPS_PENDING_PROMPT.blocked` เป็น false
  ต่างจาก error ของผู้ให้บริการที่ prompt ยังค้างอยู่ให้ไปกับข้อความถัดไป
- **โน้ตไปและหายพร้อม prompt** โน้ตของ UserPromptSubmit ถูกวางไว้ข้าง prompt ของมัน ถ้า prompt ถูกทิ้ง โน้ตก็ถูกทิ้งด้วย
- **โน้ตอยู่ใน log** event `hook-context` ทำให้ resume หรือเล่นซ้ำส่ง byte เดิมให้โมเดล โดยไม่ต้องรัน hook ใหม่
- **โน้ตยาวถูกตัด** ข้อความของ hook ยาวเกิน 10,000 ตัวอักษรถูกตัด และมีบรรทัดบอกว่าตัดแล้ว
- **hook ของโปรเจกต์ต้องเชื่อถือ workspace ก่อน** hook ใน `.claude/settings.json` ของ repo ไม่รันใน workspace ที่ไม่เชื่อถือ
