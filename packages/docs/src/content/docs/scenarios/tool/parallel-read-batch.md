---
title: "Model อ่านหลายไฟล์พร้อมกัน"
description: model ขออ่านสามไฟล์และค้นข้อความสองครั้งในคำตอบเดียว harness รันทั้งห้าพร้อมกัน แล้วบันทึกผลตามลำดับที่ model ขอ
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในแผงแชตของ VS Code โหมดใดก็ได้
    - ไม่มี hook ที่ตั้งไว้ ทุก path อยู่ใน workspace และไม่มีไฟล์ลับ
    - ผู้ใช้เปิด `src/date.ts` ค้างไว้ใน editor และมีการแก้ที่ยังไม่บันทึก
  trigger: >-
    model ตอบด้วยบล็อก `tool_use` ห้าบล็อก: `read` สามไฟล์ `grep` หนึ่งครั้ง และ `glob` หนึ่งครั้ง
  covers: [tool.parallel-read-batch]
  related: [turn.with-tools, tool.mixed-batch-sequencing, tool.bash-safe-runs, edit.applied-as-diff]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขออ่านสามไฟล์และค้นสองครั้ง"
        text: >-
          ในคำตอบเดียว model ขออ่าน `src/date.ts`, `src/date.test.ts` และ `package.json` แล้วค้นหา `parseDate`
          และหาไฟล์เทสต์ทั้งหมด การ์ดข้างล่างมาจาก run จริงที่ขออ่านสามไฟล์ในคำตอบเดียวแบบเดียวกัน
          ดูบล็อก `tool_use` ของ `read` สามบล็อก แต่ละบล็อกมี `id` ของตัวเอง
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A20-thai-question/1/session.jsonl#seq=13
          select: content
          collapse:
            - "[0].thinking"
      do: >-
        model ขอ `read` ไฟล์ `src/date.ts`, `src/date.test.ts` และ `package.json` แล้วขอ `grep` หา `parseDate`
        และ `glob` หา `**/*.test.ts` ในคำตอบเดียว จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ทั้งห้าลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens
      beat:
        title: "แชตขึ้นขั้นของทุก call"
        text: >-
          Geno บันทึกคำขอแล้วแชตขึ้นขั้นใหม่ของแต่ละ call พร้อมจุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: read src/date.ts, status: running }

    - id: together
      lane: loop
      at: tools
      beat:
        title: "Geno จัดทั้งห้าไว้ชุดเดียว"
        text: >-
          Geno แบ่ง call เป็นชุด call ในชุดเดียวกันรันพร้อมกัน การอ่านไฟล์ใน workspace ที่ไม่ใช่ไฟล์ลับ (เช่น `.env` หรือ key)
          และการค้นหา ไม่แก้อะไรและไม่ต้องถามใคร ทั้งห้าจึงรันพร้อมกันได้ในชุดเดียว ชุดหนึ่งรับได้ถึง 8 call
        from: engine
        to: engine
      do: >-
        `concurrentAt` ถามแต่ละ call ว่ารันพร้อมตัวอื่นได้หรือไม่ `read` ได้เมื่อ path ไม่ใช่ไฟล์ลับและไม่ออกนอก workspace
        `grep` และ `glob` ได้เสมอ ทั้งห้าจึงอยู่ชุดเดียวกัน (สูงสุด 8 ต่อชุด) และเริ่มพร้อมกัน
      ref: "packages/engine/src/drive.ts#\"const concurrentAt = (i: number): boolean =>\""

    - id: read
      lane: tool
      at: executor
      beat:
        title: "read อ่านผ่าน VS Code"
        text: >-
          เมื่อ VS Code แสดง session นี้อยู่ Geno ขอให้ VS Code อ่านไฟล์แทนการอ่านดิสก์เอง `src/date.ts`
          ที่คุณเปิดค้างไว้จึงมาพร้อมการแก้ที่ยังไม่บันทึก
        from: engine
        to: panel
      runs: 3
      do: >-
        `read` แต่ละตัวอ่านผ่าน `editorFiles` เมื่อมี editor ที่อ่านไฟล์ได้แสดง session นี้อยู่ engine จึงส่งคำขอ ACP
        `fs/readTextFile` แทนการอ่านดิสก์เอง
      ref: packages/engine/src/serve.ts#editorFiles

    - id: buffer
      lane: editor
      at: bridge
      do: >-
        `readTextFile` ให้ข้อความของ buffer ที่เปิดอยู่ถ้ามี หรือข้อความบนดิสก์ถ้าไม่มี
        `src/date.ts` จึงมาพร้อมการแก้ที่ผู้ใช้ยังไม่บันทึก
      ref: packages/extension/src/chat/bridge.ts#readTextFile

    - id: search
      lane: tool
      at: executor
      beat:
        title: "การค้นหาใช้สำเนาของ buffer ที่ยังไม่บันทึก"
        text: >-
          การค้นหารันบนดิสก์ใน engine แต่ก่อนค้นมันขอ buffer ที่ยังไม่บันทึกจาก VS Code (buffer คือข้อความในแท็บที่เปิดอยู่)
          แล้วค้นบนสำเนาเหล่านั้นแทนไฟล์บนดิสก์ ผลจึงตรงกับที่คุณเห็นใน editor
        from: engine
        to: machine
      runs: 2
      alongside: true
      do: >-
        `grep` และ `glob` รัน ripgrep บนดิสก์ใน process ของ engine ก่อนค้นจะขอ buffer ที่ยังไม่บันทึกจาก editor
        ด้วยคำขอ `_gcode/unsavedBuffers` แล้วค้นบนสำเนาของ buffer เหล่านั้นแทนไฟล์บนดิสก์
      ref: packages/engine/src/tools/ripgrep.ts#searchWorkspace

    - id: each-ends
      lane: loop
      at: tools
      beat:
        title: "แต่ละขั้นเสร็จไม่พร้อมกัน"
        text: >-
          call ที่เสร็จก่อนแจ้งแชตทันที คุณจึงเห็นบางขั้นเสร็จก่อนขั้นอื่น
          การอ่านแต่ละไฟล์จดเนื้อหาที่เห็นไว้เป็นฐานสำหรับการแก้ไฟล์ครั้งต่อไป
          เพื่อให้ `edit` รู้ว่าไฟล์ถูกแก้จากที่อื่นหลังอ่านหรือไม่
        from: engine
        to: panel
      do: >-
        แต่ละ call ที่เสร็จส่ง `watcher.toolEnd` ทันที แผงจึงเห็นขั้นที่เสร็จก่อนได้ `read` รอให้ call ก่อนหน้าในชุดจบก่อน
        แล้วจึงจดเนื้อหาที่เห็นเป็นฐานสำหรับ `edit` ครั้งต่อไป
      ref: "packages/engine/src/drive.ts#\"watcher.toolEnd(use, status, todo);\""

    - id: status
      lane: server
      at: updates
      do: >-
        `toolEnd` กลายเป็น `session/update` ชนิด `tool_call_update` สถานะ `completed` ทีละ call ตามลำดับที่เสร็จ
      ref: packages/engine/src/serve.ts#editorTurn
      emits: [tool_call_update, completed]

    - use: tool-result-returns
      beat:
        title: "Geno บันทึกผลตามลำดับที่ขอ"
        text: >-
          เมื่อครบทุก call Geno บันทึกผลตามลำดับที่ model ขอ ไม่ใช่ลำดับที่เสร็จ ผลพับอยู่ใต้แต่ละขั้น
          การ์ดข้างล่างเป็นผลจริงของการ์ดแรก ดู `tool_use_id` ที่ไฮไลต์ไว้ เรียงตรงกับ `id` ของ `tool_use` ทั้งสามในการ์ดแรก
        from: engine
        to: panel
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A20-thai-question/1/requests.jsonl#seq=18
          select: messages[-1].content
          highlight:
            - "[0].tool_use_id"
            - "[1].tool_use_id"
            - "[2].tool_use_id"
          collapse:
            - "[0].content"
            - "[1].content"
            - "[2].content"

    - id: next
      lane: loop
      at: step
      beat:
        title: "Model ได้ผลทั้งห้าในข้อความเดียว"
        text: >-
          Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอทั้งชุดของ model
          และผลทั้งหมดในข้อความ user เดียว เรียงตามที่ model ขอ การ์ดข้างล่างเป็นคำขอจริงจากการรันอื่นที่ขอ `read`
          `list` และ `glob` ในคำตอบเดียวแบบเดียวกัน ดูบล็อก `tool_use` สามบล็อกในข้อความ `assistant`
          และข้อความ `user` สุดท้ายที่มี `tool_result` สามบล็อกเรียงตามลำดับนั้น
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A06-read-not-cat/1/requests.jsonl#seq=9
          select: messages
          collapse: ['[0]']
          highlight: ['[1].content[2]', '[1].content[3]', '[1].content[4]', '[2]']
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model ได้ผลทั้งห้าในข้อความ user เดียว เรียงตามลำดับที่ขอ
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: reply
      lane: model
      beat:
        title: "Model ตอบหลังเห็นผลทั้งหมด"
        text: >-
          model ตอบหลังได้คำขอนี้เท่านั้น ในการรันจริงเดียวกับการ์ดก่อนหน้า model ได้ข้อมูลพอแล้ว
          จึงเขียนคำตอบสุดท้ายโดยไม่ขอ tool เพิ่ม ดูบล็อก `text` ที่ไฮไลต์ไว้ คำตอบนี้ไม่มีบล็อก `tool_use` เลย
          และจบด้วย `stop_reason: end_turn` ซึ่งแปลว่า model ตอบจบแล้ว
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A06-read-not-cat/1/session.jsonl#seq=9
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1]']
      do: >-
        model อ่าน `tool_result` ทั้งชุดแล้ว stream คำตอบสุดท้าย จบด้วย `stop_reason: end_turn` โดยไม่ขอเรียก tool
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - use: answer-streams

    - use: turn-ends
      beat:
        title: "Turn จบ"
        text: >-
          model ไม่ขออะไรเพิ่ม Geno จึงจบ turn ปุ่ม Send กลับมาแทน Stop
        from: engine
        to: panel
        end: "Turn จบแบบ done"
---

การอ่านที่ไม่เปลี่ยนอะไรและไม่ต้องถามใครรันพร้อมกันได้ ส่วนอย่างอื่นรันทีละตัว `nextToolBatch` ตัดชุดตามลำดับที่ model ขอ
ชุดหนึ่งเป็นการอ่านติดกันได้ถึง 8 ตัว หรือเป็น call อื่นตัวเดียว

| call | รันพร้อมตัวอื่นได้เมื่อ |
| --- | --- |
| `read` | path ไม่ใช่ไฟล์ลับ และไม่ใช่ path นอก workspace (เช่น path เต็มหรือ `..`) |
| `grep`, `glob`, `list` | เสมอ ไฟล์ลับถูกข้ามหรือปฏิเสธโดยไม่ถาม |
| `bash`, `edit`, `web_fetch`, call ที่อาจถามผู้ใช้ | ไม่ได้ รันชุดละตัว |

สิ่งที่ควรสังเกต

- **เห็นเสร็จเร็ว บันทึกทีหลัง** แผงเห็นแต่ละขั้นเสร็จทันทีที่ call นั้นจบ แต่ข้อความผลไปถึงแผงเมื่อทั้งชุดจบและถูกบันทึกแล้ว
  ผลใน log เรียงตามลำดับที่ model ขอ ไม่ใช่ลำดับที่เสร็จ
- **ไฟล์ที่ยังไม่บันทึก** ทั้ง `read` และ `grep` เห็นการแก้ที่ผู้ใช้ยังไม่บันทึก `read` ได้ข้อความจาก buffer
  ส่วน `grep` ค้นสำเนาของ buffer ที่ editor ส่งมา
- **ในแผง** `read` ที่ติดกันรวมเป็นขั้นเดียวที่มีชิปไฟล์ละอัน ส่วน `grep` และ `glob` เป็นขั้นของตัวเอง

เมื่อชุดมี bash ปนอยู่ ดู [Geno แบ่ง tool call แบบผสมเป็นชุดที่รันต่อกัน](/scenarios/tool/mixed-batch-sequencing/)
