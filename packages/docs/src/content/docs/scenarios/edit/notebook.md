---
title: แก้ cell ของ Jupyter notebook
description: model เรียก notebook_edit แทนการแก้ JSON ของ .ipynb ตรงๆ Geno ตรวจว่าอ่านแล้วและไฟล์ไม่เปลี่ยน แทน cell เดียว ล้าง output ของ cell code แล้วเขียนผ่าน editor
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto ไม่มีกฎ path ที่ครอบ `analysis.ipynb`
    - model `read` `analysis.ipynb` ไปแล้วใน session นี้ และเห็นหัวของแต่ละ cell พร้อม id เช่น `c3`
    - notebook ไม่ได้เปิดอยู่ในแท็บของ VS Code
  trigger: >-
    model ขอเรียก `notebook_edit` ด้วย `notebook_path` "analysis.ipynb" `cell_id` "c3" และ `new_source` เป็นโค้ดใหม่
  covers: [edit.notebook]
  related: [tool.read-special-files, edit.applied-as-diff, edit.without-read-or-stale, ed.review-hunks]
  steps:
    - id: asks
      beat:
        title: Model ขอแก้ cell `c3` ของ notebook
        text: >-
          model ไม่แก้ JSON ของ `.ipynb` ตรงๆ มันใช้ tool `notebook_edit` บอก id ของ cell และโค้ดใหม่ มันรู้ id จากตอนอ่าน notebook
          การ์ดข้างล่างมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ในการบันทึกนั้น model อ่าน notebook
          แล้วโหลด `notebook_edit` ด้วย `tool_search` ก่อน เพราะเป็น tool ที่เลื่อนไว้ (Geno ส่งแค่ชื่อในคำอธิบายของ `tool_search`)
          การ์ดคือคำตอบของ model ตามที่ Geno ใส่กลับในคำขอถัดไป ดู `input` ที่ไฮไลต์ มี `notebook_path` `cell_id` และ `new_source`
          ไม่มี `edit_mode` จึงเป็น `replace`
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/edit-notebook.jsonl#line=8
          select: messages[-2]
          highlight: ['content[1].input']
      lane: model
      do: >-
        model ขอ `notebook_edit` แบบ `replace` (ค่าเริ่มต้นของ `edit_mode`) และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens
      beat:
        title: แชตขึ้นขั้น notebook_edit
        text: Geno จัดคิวการแก้ให้รันทีละตัว แผงแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: panel
        to: you
        sees:
          kind: step
          label: notebook_edit analysis.ipynb
          status: running

    - id: input
      beat:
        title: Geno ตรวจว่าเป็น notebook และ input ครบ
        text: ไฟล์ต้องลงท้ายด้วย `.ipynb` ไฟล์อื่นได้คำบอกให้ใช้ edit การแทน cell ต้องมีทั้ง id ของ cell และโค้ดใหม่
        from: engine
        to: engine
      lane: tool
      at: executor
      do: >-
        `notebook_edit` ตรวจว่าเป็นไฟล์ `.ipynb` (ไฟล์อื่นถูกบอกให้ใช้ `edit`) แล้ว `cellEditOf` ตรวจว่าแต่ละโหมดมีฟิลด์ที่ต้องใช้
        `replace` ต้องมี `cell_id` และ `new_source` ซึ่ง `restoreHidden` คืนตัวอักษรซ่อนให้เหมือน `edit`
      ref: packages/engine/src/tools/agent.ts#cellEditOf

    - id: current
      beat:
        title: Geno ตรวจว่า model อ่าน notebook ล่าสุด
        text: Geno อ่าน notebook ปัจจุบันผ่าน VS Code แล้วเทียบกับที่ model เห็นตอนอ่าน ถ้า model ยังไม่ได้อ่าน หรือไฟล์เปลี่ยนไปแล้ว Geno ไม่เขียนอะไร รอบนี้ตรงกัน
        from: engine
        to: engine
      lane: server
      at: updates
      do: >-
        `resolveWritable` ยืนยันว่าไฟล์อยู่ใน workspace แล้วอ่านข้อความปัจจุบันผ่าน `editorFiles` ซึ่งส่งคำขอ ACP `fs/readTextFile`
      ref: packages/engine/src/serve.ts#editorFiles

    - id: base
      lane: tool
      at: executor
      do: >-
        `lastSeen` หาข้อความที่ model เห็นครั้งล่าสุด ถ้ายังไม่เคยอ่าน ได้ "read analysis.ipynb before editing it"
        ถ้า hash ไม่ตรงกับข้อความปัจจุบัน ได้คำบอกว่าไฟล์เปลี่ยนหลังอ่าน ทั้งสองทางไม่เขียนอะไร รอบนี้ hash ตรง
      ref: packages/engine/src/tools/agent.ts#notebookEditExecutor

    - id: cell
      beat:
        title: Geno แทนเฉพาะ cell `c3`
        text: Geno เปลี่ยน source ของ cell นี้ cell เดียว ล้าง output เก่าของมัน และไม่แตะไบต์อื่นของไฟล์ JSON ของ notebook จึงไม่พัง
        from: engine
        to: engine
      lane: tool
      at: executor
      do: >-
        `editNotebook` แทน source ของ cell `c3` เท่านั้น cell code ถูกล้าง output และ execution count
        ส่วนอื่นของไฟล์คงไบต์เดิม JSON ของ notebook จึงไม่พังเหมือนการแก้ด้วย `edit`
      ref: packages/engine/src/tools/notebook.ts#editNotebook

    - id: write
      beat:
        title: VS Code เขียน notebook แล้วแชตแสดง diff
        text: Geno ส่งไฟล์ทั้งไฟล์พร้อม hash ของฉบับที่ model เห็นให้ VS Code เขียน VS Code เทียบ hash นั้นกับไฟล์บนดิสก์อีกครั้งว่ายังเป็นฉบับเดียวกัน แล้วส่งการเปลี่ยนแปลงให้แผงแชตแสดง
        from: engine
        to: panel
      lane: server
      at: updates
      do: >-
        `ctx.files.write` ส่ง `fs/writeTextFile` ที่มีข้อความทั้งไฟล์หลังแก้พร้อม hash ของฐาน
      ref: packages/engine/src/serve.ts#editorFiles
      emits: [BASE_HASH_META]

    - id: buffer
      lane: editor
      at: bridge
      do: >-
        `writeTextFile` เทียบ hash กับข้อความบนดิสก์ ตรงกัน จึงเขียน ถ้าไม่ตรง ได้ stale และ `notebook_edit` บอก model ว่าไฟล์เปลี่ยน
        หลังเขียน callback ที่ `Chat` ส่งให้ `writeTextFile` ส่ง action `diff` ให้แผง เพราะ session นี้เป็นของแผงเอง
      ref: packages/extension/src/chat/bridge.ts#writeTextFile
      emits: [diff]

    - id: result
      beat:
        title: Geno เตรียมผลว่าแทน cell แล้ว
        text: Geno เขียนข้อความผลไว้ใน session log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร ผลบอกว่า cell นี้อยู่ลำดับไหนในไฟล์ output ถูกล้าง และไม่ต้องอ่านไฟล์ซ้ำ Geno จำ notebook ฉบับใหม่ไว้สำหรับการแก้ครั้งถัดไป
        from: engine
        to: engine
      lane: tool
      at: executor
      do: >-
        `notebook_edit` จำข้อความใหม่เป็นฐานของการแก้ครั้งถัดไป และตอบ "Replaced cell c3 of analysis.ipynb, now cell 4 of 9: code, with its outputs cleared.
        The file state is current in your context; no need to read it back." พร้อมการเปลี่ยนแปลงให้แผงแสดงเป็น diff
      ref: packages/engine/src/tools/agent.ts#notebookEditedText

    - use: tool-result-returns

    - id: next
      beat:
        title: Geno เรียก model อีกครั้ง
        text: >-
          Geno ส่งผลของ `notebook_edit` กลับไปให้ model ในคำขอใหม่ model จึงรู้ว่าแก้ cell แล้ว และแก้ cell ถัดไปได้เลยโดยไม่ต้องอ่าน notebook ใหม่
          การ์ดข้างล่างคือ `tool_result` จากการบันทึกเดียวกัน ดู `content` ที่ไฮไลต์ บอกว่า cell `c3` อยู่ลำดับ 4 จาก 9 และ output ถูกล้างแล้ว
        from: engine
        to: model
        end: Model แก้ cell ต่อได้ทันที
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/edit-notebook.jsonl#line=8
          select: messages[-1]
          highlight: ['content[0].content']
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` model แก้ cell ถัดไปได้เลยโดยไม่ต้องอ่าน notebook ใหม่
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

หน้านี้เล่าว่า model แก้ cell ของ Jupyter notebook อย่างไร ไฟล์ `.ipynb` เป็น JSON ก้อนใหญ่ที่มี source และ output ของทุก cell
ถ้า model แก้ด้วย `edit` ธรรมดา มันต้องคัดลอก JSON ที่ escape แล้วให้ตรงทุกตัวอักษร และทำ JSON พังได้ง่าย Geno จึงมี tool แยก

`notebook_edit` ทำงานกับ cell ไม่ใช่กับข้อความ ทำให้ model ไม่ต้องคัดลอก JSON ของ notebook มาเป็น `old_str`

| `edit_mode` | ต้องมี | ผล |
| --- | --- | --- |
| `replace` (ค่าเริ่มต้น) | `cell_id`, `new_source` | แทน source เปลี่ยนชนิดได้ด้วย `cell_type` |
| `insert` | `new_source`, `cell_type` | เพิ่ม cell หลัง `cell_id` หรือที่ต้นไฟล์ |
| `delete` | `cell_id` | ลบ cell |

สิ่งที่ควรสังเกต

- **กฎเดียวกับ `edit`** ต้องอ่านก่อน ไฟล์ต้องไม่เปลี่ยนหลังอ่าน ต้องอยู่ใน workspace และ[กฎ permission](/start/glossary/) แบบ `Edit(...)` ครอบ `notebook_edit` ด้วย
- **cell ที่ไม่มี id** ได้ชื่อ `cell-0`, `cell-1` ตามตำแหน่ง การเพิ่มหรือลบ cell จึงเปลี่ยนชื่อของ cell ที่ตามหลัง ผลบอก model เรื่องนี้
- **output ของ cell code หายไป** การแก้ cell code ล้าง output เดิม เพราะ output นั้นไม่ใช่ผลของโค้ดใหม่แล้ว
