---
title: "Steer ที่ไม่ถูกส่ง"
description: ข้อความที่มีไฟล์แนบหรือ @mention กด Send now ไม่ได้และรอในคิวแทน ส่วนข้อความถึง subagent ที่เพิ่งจบ engine ปฏิเสธว่าลูกจบไปแล้ว
tableOfContents: false
sidebar:
  order: 6
scenario:
  surface: vscode
  given:
    - turn ของแชตนี้กำลังทำงาน และเรียก `agent` ให้เอเจนต์ลูก `explore` ทำงานอยู่
    - ช่องพิมพ์ไม่มีข้อความรอในคิว
  trigger: >-
    ผู้ใช้อยากส่งข้อความเข้า turn ที่กำลังทำงาน โดยไม่รอให้ turn จบ
  covers: [ctl.steer-refused]
  related: [ctl.steer-delivered, ctl.queued-followup, ctl.steer-missed-runs-next, sub.user-steers-child, start.attach-and-mention]
  steps:
    - id: want
      lane: user
      beat:
        title: "คุณอยากส่งข้อความเข้า turn ที่ทำงาน"
        text: >-
          turn กำลังทำงานและมี subagent ชื่อ explore ทำงานอยู่ คุณอยากส่งข้อความโดยไม่รอให้ turn จบ
          ลองเลือกว่าข้อความไปที่ไหน
        from: you
        to: panel
        ask: "ข้อความไปที่ไหน"
      do: ผู้ใช้พิมพ์ข้อความที่จะส่งระหว่าง turn
      phase: running-tools
      fork:
        ask: ข้อความไปที่ไหน และมีอะไรติดไปด้วย
        options:
          - id: extras
            label: ถึงแชต พร้อมไฟล์แนบหรือ @mention
            steps:
              - lane: panel
                at: composer
                beat:
                  title: "ปุ่ม Send now จางลง"
                  text: >-
                    ร่างของคุณมี `@src/app.ts` ไฟล์แนบและ mention ไปกับ turn ถัดไปเท่านั้น ปุ่ม Send now ยังอยู่แต่ใช้ไม่ได้
                    และบอกเหตุผลเมื่อชี้
                  from: panel
                  to: you
                  sees: "ปุ่ม Send now จางลง ชี้แล้วขึ้น \"Attachments and @ mentions go with the next turn, so this one waits in the queue\""
                do: >-
                  ร่างข้อความมี `@src/app.ts` `sendNowOf` นับไฟล์แนบและ mention เป็น extras จึงให้ผล `blocked`
                  ปุ่ม Send now ยังอยู่แต่เป็น `aria-disabled` และ tooltip บอกเหตุผล
                sees: >-
                  ปุ่ม Send now จางลง ชี้แล้วขึ้น "Attachments and @ mentions go with the next turn, so this one waits in the queue"
                ref: packages/extension/src/chat/steer-model.ts#sendNowOf
              - lane: user
                beat:
                  title: "คุณกด Send now อยู่ดี ข้อความเข้าคิว"
                  text: >-
                    คุณกด Send now หรือ Cmd-Enter อยู่ดี แผงเก็บข้อความเข้าคิวเหมือนกด Enter ไม่มีอะไรไปถึง VS Code หรือ engine
                    ทัวร์ข้อความในคิวเล่าต่อว่ามันถูกส่งเมื่อไร
                  from: you
                  to: panel
                  end: "ข้อความรอในคิว"
                  sees: "ป้าย \"Queued\" เหนือช่องพิมพ์ ชี้แล้วขึ้น \"Sends when the turn finishes\""
                do: ผู้ใช้กด Send now หรือ Cmd-Enter อยู่ดี
              - lane: panel
                at: composer
                do: >-
                  `steerNow` เห็นว่าไม่ `ready` จึงเรียก `submit()` แทน ข้อความเข้าคิวเป็นข้อความ Queued เหมือนกด Enter
                  ไม่มีอะไรไปถึง extension host หรือ engine
                sees: ป้าย "Queued" เหนือช่องพิมพ์ (ชี้แล้วขึ้น "Sends when the turn finishes")
                ref: packages/extension/src/chat/webview.ts#steerNow
                goto: ctl.queued-followup

          - id: finished-child
            label: ถึงเอเจนต์ลูก ขณะที่ลูกกำลังจบ
            steps:
              - lane: panel
                at: rail
                beat:
                  title: "คุณส่งข้อความถึง subagent"
                  text: >-
                    คุณเปิดบทสนทนาของ explore จากแถวของมัน พิมพ์ "ดูโฟลเดอร์ test ด้วย" แล้วกด Send ช่องพิมพ์ของ subagent ส่ง
                    steer ไปที่ session ของมัน
                  from: you
                  to: engine
                  sees: "ใต้ช่องขึ้น \"Sending… it lands at the next tool round\""
                do: >-
                  ผู้ใช้เปิดบทสนทนาของลูกจากแถวของมัน พิมพ์ "ดูโฟลเดอร์ test ด้วย" ในช่อง "Message explore…" แล้วกด Send
                  ช่องโพสต์ `steer` ถึงลูกตาม session id
                sees: ใต้ช่องขึ้น "Sending… it lands at the next tool round"
                ref: "packages/extension/src/chat/steer-view.ts#\"post({ type: 'steer', target, text });\""
                emits: [steer]
              - lane: editor
                at: chat
                do: >-
                  `SteerHost.steerSession` ส่ง `session/prompt` ที่มี `STEER_META` ไปที่ session ของลูก
                ref: packages/extension/src/chat/steer-host.ts#SteerHost.steerSession
                emits: [STEER_META]
              - lane: child@explore
                at: loop
                beat:
                  title: "Subagent จบก่อนข้อความถึง"
                  text: >-
                    explore เขียนรายงานแล้วจบรอบของมันก่อนข้อความจะถึงจุดที่แทรกได้ inbox ของมันปิดแล้ว
                  from: model
                  to: engine
                alongside: true
                do: >-
                  ลูกเรียก `report` แล้วจบรอบของมันก่อนข้อความจะถึงจุดปลอดภัย inbox ของลูกปิด
                ref: packages/engine/src/steer.ts#Steers.release
              - lane: server
                at: turns
                beat:
                  title: "Geno ปฏิเสธว่า subagent จบไปแล้ว"
                  text: >-
                    ข้อความในแชตหลักที่มาไม่ทันจะกลายเป็น turn ถัดไป แต่ subagent ไม่มี turn ถัดไป engine จึงปฏิเสธ
                  from: engine
                  to: panel
                do: >-
                  `steerRunning` ได้ผล `next-turn` (inbox ปิดแล้ว หรือปิดขณะข้อความรออยู่) แต่ลูกไม่มี turn ถัดไป
                  engine จึงตอบ `invalidRequest` "the subagent already finished"
                ref: packages/engine/src/steer.ts#steerRunning
                emits: [the subagent already finished]
              - lane: editor
                at: chat
                do: >-
                  คำขอถูกปฏิเสธ `failed` แปลงเป็นผล `failed` พร้อมข้อความ แล้วโพสต์ `steered` ถึงช่องของลูก
                ref: packages/extension/src/chat/steer-host.ts#SteerHost.steerSession
                emits: [steered]
              - lane: panel
                at: rail
                beat:
                  title: "แชตของ subagent ขึ้นบรรทัดสีแดง"
                  text: >-
                    ช่องพิมพ์ของ subagent ซ่อนเพราะมันไม่ทำงานแล้ว แต่บรรทัดสถานะยังอยู่ turn ของแชตหลักทำงานต่อ และรายงานของ
                    subagent ไปถึงตามปกติ
                  from: panel
                  to: you
                  end: "subagent จบแล้ว turn ทำต่อ"
                  sees: "บรรทัดสถานะสีแดง \"explore already finished\" ใต้บทสนทนาของ subagent"
                do: >-
                  `fieldStatus` จับคำว่า "already finished" แล้วเขียนเป็นชื่อของลูก ช่องพิมพ์ของลูกซ่อนเพราะลูกไม่ทำงานแล้ว
                  แต่บรรทัดสถานะยังอยู่ turn ของแม่ทำงานต่อ และรายงานของลูกไปถึงแม่ตามปกติ
                sees: บรรทัดสถานะสีแดง "explore already finished" ใต้บทสนทนาของลูก
                ref: packages/extension/src/chat/steer-model.ts#fieldStatus
                end: { turn: continues }
---

steer คือข้อความล้วนที่เข้าไปใน log ของ turn ที่ทำงานอยู่ มีสองที่ที่มันไม่ผ่าน

| ที่ | กันโดย | ผล |
| --- | --- | --- |
| แผงแชต | `sendNowOf`: ร่างมีไฟล์แนบหรือ `@` mention | กลายเป็นข้อความ Queued ส่งเมื่อ turn จบแบบ done |
| engine | `steerRunning`: ข้อความถึงลูกที่จบแล้ว | ปฏิเสธ "the subagent already finished" |
| engine | `steerRunning`: มีบล็อกที่ไม่ใช่ข้อความ หรือข้อความว่าง | ปฏิเสธ "a steer is text only; ..." หรือ "the steer has no text" |

สิ่งที่ควรสังเกต

- **แผงของ Geno ไม่เคยส่งบล็อกที่ไม่ใช่ข้อความ** การกันของ engine เรื่อง "text only" มีไว้สำหรับ client ACP ตัวอื่น
  ไฟล์แนบและ mention ต้องไปกับ turn ใหม่ เพราะ `logPrompt` บันทึกมันพร้อม prompt ตอนเปิด turn เท่านั้น
- **steer ถึงแชตที่ถูกปฏิเสธกลับเข้าคิว** ถ้า engine ปฏิเสธ steer ถึงแชตขณะ turn ยังทำงาน `followupSteered` คืนข้อความเป็น Queued
  ถ้า turn จบแล้ว ข้อความกลับไปที่ช่องพิมพ์
- **ส่งได้ทีละข้อความ** ขณะข้อความหนึ่งยัง "Sending now" ปุ่ม Send now ของข้อความถัดไปขึ้นว่า
  "One message at a time: this one can go once the last one lands"

ข้อความที่เข้าคิวไปต่อที่ [พิมพ์ข้อความถัดไปเข้าคิวขณะ turn ทำงาน](/scenarios/ctl/queued-followup/)
