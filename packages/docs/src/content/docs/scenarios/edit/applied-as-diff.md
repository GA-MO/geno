---
title: แก้ไฟล์แล้วแสดงเป็น diff
description: model แก้ไฟล์ที่อ่านแล้ว การแก้ลง buffer ของ VS Code ผ่าน ACP บันทึกลงดิสก์ และแผงแสดง diff ของ turn
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto และ `gcode.review.mode` เป็น `auto` (ค่าเริ่มต้น)
    - ก่อนหน้าใน turn นี้ model `read` ไฟล์ `src/date.ts` แล้ว และไฟล์ยังไม่เปลี่ยนตั้งแต่นั้น
    - ไม่มี hook และไม่มีกฎ path ของ workspace
  trigger: >-
    model ขอเรียก `edit` บน `src/date.ts` ด้วย `old_str` และ `new_str`
  covers: [edit.applied-as-diff]
  related: [edit.create-file, ed.review-auto-undo, edit.without-read-or-stale, edit.old-str-mismatch, ed.review-hunks]
  steps:
    - id: asks
      beat:
        title: Model ขอแก้ `src/date.ts`
        text: model อ่านไฟล์นี้ไปแล้วใน turn นี้ ตอนนี้มันขอแทนข้อความช่วงหนึ่ง (`old_str`) ด้วยข้อความใหม่ (`new_str`) การ์ดข้างล่างเป็นคำขอจริงจากการรันที่แก้ `src/config.ts` แบบเดียวกัน ดูบล็อก `tool_use` ที่ `name` เป็น `edit` และสอง field ที่ไฮไลต์ (`\t` คือ tab ในไฟล์)
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A04-blind-edit-recovery/1/session.jsonl#seq=7
          select: content[1]
          highlight:
            - input.old_str
            - input.new_str
      lane: model
      do: >-
        model ขอเรียก `edit` กับ `src/date.ts` แทนข้อความหนึ่งช่วง (`old_str`) ด้วยข้อความใหม่ (`new_str`)
        และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens
      beat:
        title: แชตขึ้นขั้น edit
        text: Geno จัดคิวการแก้นี้ให้รันทีละตัว เพราะมันเปลี่ยนไฟล์ แผงแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: panel
        to: you
        sees:
          kind: step
          label: edit src/date.ts
          status: running

    - id: guards
      beat:
        title: Geno ตรวจว่าแก้ไฟล์นี้ได้
        text: ไฟล์ต้องอยู่ใน workspace (โฟลเดอร์ที่คุณเปิด) และ model ต้องเคยอ่านมันมาก่อน Geno จึงรู้ว่า model แก้จากข้อความไหน ในโหมด Ask และ Auto การแก้ใน workspace ไม่ต้องขอ permission จึงไม่มีการ์ดถามคุณ
        from: engine
        to: engine
      lane: tool
      at: executor
      do: >-
        `edit` ตรวจว่า path เขียนได้ (path จริงอยู่ใน workspace, scratchpad ของ session หรือไดเรกทอรีที่ตั้งให้เขียนได้) แล้วหาฐาน: ข้อความที่ model เห็นครั้งล่าสุดจาก `read`
        ถ้าไม่เคยอ่านไฟล์ที่มีอยู่ การแก้จะถูกปฏิเสธว่า "read src/date.ts before editing it"
        ในโหมด Ask และ Auto การแก้ใน workspace ไม่ขึ้นการ์ดขออนุญาต
      ref: packages/engine/src/tools/agent.ts#editExecutor

    - id: apply
      beat:
        title: Geno หา `old_str` ในไฟล์
        text: Geno อ่านไฟล์อีกครั้งเพื่อให้แน่ใจว่ายังไม่มีใครแก้ แล้วหาข้อความเดิม ซึ่งต้องตรงทุกตัวอักษรและมีที่เดียว จากนั้นแทนด้วยข้อความใหม่
        from: engine
        to: engine
      lane: tool
      at: executor
      do: >-
        `applyEditToFile` อ่านข้อความปัจจุบันอีกครั้ง ตรวจว่ายังตรงกับฐาน แล้ว `strReplace` หา `old_str` ซึ่งต้องตรงทุกตัวอักษรและมีที่เดียว
        ตัวอักษรซ่อนที่ `read` แสดงเป็นรหัสถูกแปลงกลับก่อน การแก้จึงตรงกับไบต์จริงของไฟล์
      ref: packages/engine/src/files.ts#applyEditToFile

    - use: edit-write-lands
      beat:
        title: VS Code เขียนไฟล์แล้วแชตแสดง diff
        text: engine ไม่เขียนดิสก์เอง มันส่งข้อความทั้งไฟล์ให้ VS Code เขียน การแก้จึงเข้า buffer (ข้อความของไฟล์ที่ VS Code ถือไว้ รวมส่วนที่ยังไม่ save) ที่คุณเปิดอยู่ด้วย ขั้นของ edit บอกจำนวนบรรทัดที่เพิ่มและลบ (การรันจริงข้างล่างแก้สองบรรทัดใน `src/config.ts` ขั้นจึงขึ้น +2 −2) และท้าย turn มีการ์ดการเปลี่ยนแปลงให้รีวิว
        from: engine
        to: panel
        sees:
          - kind: step
            label: Edited date.ts
            status: done

    - id: result
      beat:
        title: Geno เตรียมผลว่าแก้แล้ว
        text: Geno เขียนข้อความผลไว้ใน session log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร ถ้าโปรเจกต์ตั้งคำสั่ง check (คำสั่งตรวจที่คุณตั้งไว้ เช่นเทสต์) Geno รันมันแล้วต่อผลท้ายข้อความ ผลยังเป็น ok แม้ check จะล้มเหลว เหมือนในการรันจริงนี้ ในการ์ด บรรทัดแรกของ `content` บอกว่าแก้แล้วและไม่ต้องอ่านไฟล์ซ้ำ ต่อด้วย output ของ check ที่ล้มเหลว
        from: engine
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A04-blind-edit-recovery/1/requests.jsonl#seq=10
          select: messages[-1].content[0]
          highlight: [content]
      lane: tool
      at: executor
      do: >-
        `edit` อ่านข้อความที่เขียนแล้วกลับมาเป็นฐานใหม่ ถ้าตั้งคำสั่ง `check` ไว้ จะรันใน sandbox แล้วต่อผลท้ายข้อความ
        ข้อความผลบอก model ว่าไม่ต้องอ่านไฟล์ซ้ำ สถานะเป็น `ok` แม้ check จะล้มเหลว
      ref: "packages/engine/src/tools/agent.ts#\"const editedText = \""

    - id: post-hooks
      lane: policy
      at: hooks
      do: >-
        PostToolUse hooks ได้อ่านการแก้ในรูปเดียวกับ tool Edit ของ Claude Code เมื่อไม่มี hook ก็ผ่านไป
      ref: packages/engine/src/hooks.ts#AFTER_TOOL_EVENT
      emits: [PostToolUse]

    - use: tool-result-returns

    - id: next
      beat:
        title: Geno เรียก model อีกครั้ง
        text: Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอ edit ของ model และผลที่ Geno เตรียมไว้ model จึงรู้ว่าแก้สำเร็จ ก่อนส่ง Geno เก็บ checkpoint (ภาพถ่ายไฟล์ใน workspace) ที่รวมไฟล์นี้ไว้ ให้คุณย้อนการแก้ได้ภายหลัง การ์ดข้างล่างเป็น `messages` ของคำขอจริงจากการรันเดียวกัน ข้อความเก่าพับไว้ ที่ไฮไลต์คือคำขอ `edit` ของ model และ `tool_result` ที่ตอบมัน สองบล็อกจับคู่กันด้วย `id` กับ `tool_use_id` ที่ตรงกัน
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A04-blind-edit-recovery/1/requests.jsonl#seq=10
          select: messages
          collapse: ['[0]', '[1]', '[2]']
          highlight: ['[3].content[1]', '[4].content[0]']
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ก่อนเรียก model `callModel` บันทึก `checkpoint` ใหม่
        ซึ่งรวมไฟล์ที่เพิ่งแก้ เพราะการแก้ถูกบันทึกลงดิสก์แล้ว
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: reply
      beat:
        title: Model ตอบหลังเห็นผล
        text: model ตอบหลังได้คำขอนี้เท่านั้น ในการ์ด ความคิดของ model พับไว้ ที่ไฮไลต์คือ input ของ `bash` ในการรันจริงนี้ model เห็นว่า check ล้มเหลวที่เทสต์ของ slug ซึ่งไม่เกี่ยวกับไฟล์ที่แก้ จึงขอรัน `bash` เพื่อยืนยันว่าเทสต์ล้มเหลวอยู่ก่อนแล้ว
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A04-blind-edit-recovery/1/session.jsonl#seq=10
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].input']
        end: Model อ่านผลแล้วทำต่อ
      lane: model
      do: >-
        model อ่าน `tool_result` ของ `edit` แล้วตอบด้วยคำขอใหม่ ในการรันนี้คือ `bash` และจบคำตอบด้วย `stop_reason: tool_use`
        turn วนต่อไปจนกว่า model จะตอบโดยไม่ขอ tool
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

หน้านี้เล่าเส้นทางปกติของการแก้ไฟล์ model ขอ `edit` Geno ตรวจ แก้ไฟล์ แสดง diff (ความต่างก่อนกับหลังแก้) ในแผง
แล้วส่งผลกลับให้ model เป็นฐานของหน้าอื่นในหมวดนี้ที่เล่าว่าการแก้ล้มเหลวหรือถูกปฏิเสธอย่างไร

การแก้ไฟล์ของ Geno ไม่ได้เขียนดิสก์จาก engine โดยตรงเมื่อมี VS Code แสดง session อยู่ engine ส่งข้อความทั้งไฟล์ไปให้ extension
แล้ว extension แก้ buffer ด้วย `WorkspaceEdit` ผลคือ

- การแก้ค้างที่ผู้ใช้ยังไม่บันทึกถูกนับเป็นฐาน ถ้าผู้ใช้แก้ไฟล์หลัง model อ่าน การแก้ของ model จะ stale (อิงข้อความเก่า) และ model ต้องอ่านใหม่
- ผู้ใช้กด Cmd-Z ใน editor เพื่อย้อนการแก้แต่ละครั้งได้
- buffer ที่ไม่มีการแก้ค้างถูกบันทึกทันที checkpoint ที่ snapshot ดิสก์ก่อนการเรียก model แต่ละครั้งจึงเห็นการแก้ของ Geno

สิ่งที่ควรสังเกต

- **Edit ไม่ถามในโหมด Ask และ Auto** ผู้ใช้ตรวจการแก้ทีหลัง: ในโหมด review แบบ `auto` ท้าย turn มีแถว "1 file changed · Undo"
  ดู [ดูการเปลี่ยนแปลงของ turn และ Undo](/scenarios/ed/review-auto-undo/) ในโหมด `review` แต่ละ [hunk](/start/glossary/) มี Keep และ Undo
- **โหมด Plan** ปฏิเสธ `edit` ทั้งหมด ผลเป็น error ธรรมดา แผงจึงแสดงว่าขั้นล้มเหลว ไม่ใช่ถูกปฏิเสธ
- **ไม่มี editor ก็แก้ได้** เมื่อไม่มี editor ที่เขียนไฟล์ได้แสดง session นั้น (เช่นใน CLI) หรือ session ทำงานใน [lane](/start/glossary/) (git worktree แยก)
  engine เขียนไฟล์ชั่วคราวแล้ว rename ทับ ไม่มี action `diff` สดในแผง
