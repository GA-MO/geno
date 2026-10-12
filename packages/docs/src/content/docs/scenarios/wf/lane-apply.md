---
title: นำ lane กลับมาใช้
description: ผู้ใช้กด Apply บน lane ในแผง Lanes การเปลี่ยนแปลงของ lane ถูก merge เข้า checkout หลักเป็น turn หนึ่งของแชต ทุกไฟล์เข้าระบบ review หรือไม่เขียนอะไรเลยถ้าชนกัน
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - "lane `worker-1a2b3c4d` ที่ลูก worker ทิ้งไว้มีการแก้ `src/log.ts` และ `package.json` และงานของ lane จบแล้ว"
    - แชตที่แสดงอยู่เป็นแชตของ checkout หลัก ไม่มี turn ทำงาน
  trigger: >-
    ผู้ใช้เปิดแผง Lanes แล้วกด Apply บน lane นั้น
  covers: [wf.lane-apply]
  related: [sub.worktree-lane, wf.arena-best-of-n, ed.review-hunks, wf.spinoff]
  steps:
    - id: pane
      lane: panel
      at: lanes
      do: >-
        แผง Lanes แสดงทุก lane ของโฟลเดอร์: งาน สถานะ diff ผลของ check ค่าใช้จ่าย และปุ่ม Open, Apply, Discard
      sees: >-
        แถว "worker-1a2b3c4d" บอกจำนวนไฟล์และบรรทัดที่เปลี่ยน และปุ่ม [Open] [Apply] [Discard]
      ref: packages/extension/src/chat/lanes-panel.ts#lanesPanel
      phase: idle

    - id: click
      lane: user
      do: ผู้ใช้กด Apply

    - id: ask
      lane: editor
      at: chat
      do: >-
        `Chat.applyLane` ยอมเฉพาะเมื่อแชตที่แสดงเป็นของ checkout หลัก แล้วส่ง prompt "Apply lane worker-1a2b3c4d"
        ด้วยคำขอ ACP `session/prompt` ที่มี `_meta` `gcode/laneApply` เป็นชื่อ lane
      ref: "packages/extension/src/chat/chat.ts#\"async applyLane(name: string): Promise<acp.StopReason>\""
      emits: [session/prompt, gcode/laneApply]

    - id: bubble
      lane: panel
      at: rail
      alongside: true
      do: แชตขึ้น turn ใหม่ที่ข้อความของผู้ใช้คือคำสั่ง apply
      sees: บับเบิล "Apply lane worker-1a2b3c4d" หัวข้อเป็น "working"
      ref: packages/extension/src/chat/webview.ts#render

    - id: turn
      lane: server
      at: turns
      do: >-
        `runTurn` เห็น `gcode/laneApply` จึงไม่เรียก `runAgent` แต่เรียก `applyLaneTurn` ภายใน lock ของ session
        lane ต้องเป็นของ repository เดียวกับแชต และงานที่ผูกกับ lane ต้องไม่รันอยู่ (`idleLane`)
      ref: packages/engine/src/lane-hooks.ts#applyLaneTurn
      phase: running-tools

    - id: merge
      lane: server
      at: turns
      do: >-
        `applyLane` merge แบบสามทางทีละไฟล์ระหว่างฐานของ lane, lane และ checkout หลักตอนนี้ (รวม buffer ที่ยังไม่บันทึก)
        ทั้งหมดหรือไม่มีเลย: ไฟล์เดียวที่ชนทำให้ไม่มีอะไรถูกเขียน
      ref: packages/engine/src/lanes.ts#applyLane
      fork:
        ask: merge ชนกันไหม
        options:
          - id: clean
            label: ไม่ชน
            then: checkpoint

          - id: conflict
            label: ชน
            steps:
              - lane: server
                at: turns
                do: >-
                  ผู้ใช้แก้ `src/log.ts` บรรทัดเดียวกันใน checkout หลักไปแล้ว `applyLaneTurn` บันทึก event `lane-apply` ที่มีรายการที่ชน
                  ไม่เขียนไฟล์ ไม่มี checkpoint แล้วส่งข้อความสรุปเป็นคำตอบของ turn
                ref: packages/core/src/tasks.ts#laneApplyText
                emits: [lane-apply]
              - lane: panel
                at: rail
                do: ข้อความของ turn บอกว่าไม่มีอะไรถูก apply และไฟล์ไหนชนเพราะอะไร
                sees: >-
                  "Nothing from lane worker-1a2b3c4d was applied: 1 file conflicts with the main checkout."
                  "- `src/log.ts`: the lane and the main checkout changed the same lines"
                ref: packages/core/src/lanes.ts#LANE_CONFLICT_REASONS
              - lane: server
                at: turns
                do: >-
                  turn จบ `end_turn` lane ยังอยู่ครบ ผู้ใช้แก้ที่ checkout หลักแล้ว Apply ใหม่ หรือเปิด lane ไปดูได้
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META]
                phase: ending
                end: { turn: done, reason: end_turn }

    - id: checkpoint
      lane: server
      at: turns
      do: >-
        ก่อนเขียนอะไร `takeCheckpoint` บันทึก checkpoint ของ workspace ไว้ให้ Undo All ย้อนการ apply ทั้งหมดได้
      ref: packages/engine/src/checkpoints.ts#takeCheckpoint
      emits: [checkpoint]

    - id: steps
      lane: server
      at: updates
      do: >-
        แต่ละไฟล์ถูกเขียนเป็นขั้น `edit` สังเคราะห์ (`lane-<seq>-<n>`) แชตจึงเห็นขั้นต่อไฟล์เหมือนเอเจนต์แก้
      ref: "packages/engine/src/lane-hooks.ts#\"watcher.toolStart(use, `edit ${path.relative(repo.main, target)}`);\""
      emits: [tool_call]

    - use: edit-write-lands

    - id: logged
      lane: server
      at: turns
      do: >-
        `applyLaneTurn` บันทึก event `lane-apply` พร้อมไฟล์ที่เขียนและที่ลบ แล้วส่งข้อความสรุปเป็นคำตอบของ turn
      ref: packages/core/src/tasks.ts#laneApplyText
      emits: [lane-apply]

    - id: summary
      lane: panel
      at: rail
      alongside: true
      do: ข้อความสรุปขึ้นใต้ขั้นของไฟล์
      sees: >-
        "Applied 2 files from lane worker-1a2b3c4d."
      ref: packages/extension/src/chat/webview.ts#render

    - id: ends
      lane: server
      at: turns
      do: >-
        turn จบ `end_turn` โดยไม่มีการเรียกโมเดล hunk ของทุกไฟล์รอผู้ใช้ Keep หรือ Undo ตามโหมด review ของ editor
        lane ยังอยู่จนผู้ใช้ Discard
      ref: packages/engine/src/serve.ts#TURN_ENDS
      emits: [TURN_END_META]
      phase: ending

    - id: footer
      lane: panel
      at: rail
      do: >-
        การ์ดการเปลี่ยนแปลงท้าย turn แสดงไฟล์ทั้งสอง และ editor แสดง hunk ที่รอตรวจ
      sees: หัวข้อ "worked for 1s" และการ์ด "2 files changed"
      ref: packages/extension/src/chat/render.ts#changesCard
      end: { turn: done, reason: end_turn }
---

Apply คือ turn ของแชตที่ไม่มีโมเดล: engine merge แล้วเขียนผ่าน editor เหมือนการแก้ของเอเจนต์
การเปลี่ยนแปลงของ lane จึงได้ทุกอย่างที่การแก้ปกติได้: diff ในแชต hunk ที่รอตรวจ และ checkpoint ให้ Undo All

สิ่งที่ควรสังเกต

- **ทั้งหมดหรือไม่มีเลย** ไม่มีการ apply บางไฟล์ ถ้าอยากได้บางส่วน ใช้ Graft ในแผง Arena ซึ่งเลือก hunk ได้
- **ต้องเปิดแชตของ checkout หลัก** แชตที่อยู่ใน lane apply lane อื่นเข้ามาไม่ได้
- **`gcode lane apply` ต่างกัน** คำสั่งใน CLI เขียนลงดิสก์ตรงๆ ไม่มี review และไม่มี checkpoint (`--dry-run` ดูก่อนได้)
