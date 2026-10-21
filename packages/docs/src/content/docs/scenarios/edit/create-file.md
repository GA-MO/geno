---
title: "สร้างไฟล์ใหม่ด้วย edit"
description: model เรียก edit ด้วย create true กับ path ที่ยังไม่มี Geno ไม่ต้องให้อ่านก่อน เขียนไฟล์ใหม่ผ่าน VS Code และแสดงเป็น diff
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto และไม่มี hook
    - ยังไม่มีไฟล์ `src/slug.ts` ใน workspace
  trigger: >-
    model ขอเรียก `edit` ด้วย `path: src/slug.ts`, `create: true` และเนื้อหาทั้งไฟล์ใน `new_str`
  covers: [edit.create-file]
  related: [edit.applied-as-diff, ed.review-auto-undo, tool.unknown-or-invalid]
  steps:
    - id: asks
      beat:
        title: Model ขอสร้าง `src/slug.ts`
        text: "model เรียก edit ด้วย `create: true` และเนื้อหาทั้งไฟล์ใน `new_str` ไม่มี `old_str` เพราะยังไม่มีอะไรให้แทน การ์ดเป็นคำขอจริงจากการรันที่สร้าง `src/clamp.ts` ดู `input.create` กับ `input.path` ที่ไฮไลต์"
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A03-new-file-create/fix-a1/session.jsonl#seq=23
          select: content[2]
          highlight:
            - input.create
            - input.path
      lane: model
      do: >-
        model ขอเรียก `edit` เพื่อสร้าง `src/slug.ts` ด้วย `create: true` และเนื้อหาทั้งไฟล์ แล้วจบคำตอบด้วย `stop_reason: tool_use`
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
        text: Geno จัดคิวการแก้นี้ให้รันทีละตัว เพราะมันเขียนไฟล์ แผงแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: panel
        to: you
        sees:
          kind: step
          label: edit src/slug.ts
          status: running

    - id: missing
      beat:
        title: Geno เห็นว่าไฟล์ยังไม่มี
        text: Geno ถาม VS Code หาไฟล์ แล้วได้คำตอบว่าไม่มี ไฟล์ที่ยังไม่มีจึงไม่ต้องอ่านก่อน ต่างจากไฟล์ที่มีอยู่แล้ว เนื้อหาใหม่คือ `new_str` ทั้งก้อน
        from: engine
        to: engine
      lane: tool
      at: executor
      do: >-
        `edit` อ่านไฟล์ผ่าน editor เพื่อหาฐาน editor ตอบว่าไม่มีไฟล์ ฐานจึงเป็นไฟล์ว่าง (hash เป็น null)
        ไฟล์ที่ยังไม่มีไม่ต้องอ่านก่อนแก้ ต่างจากไฟล์ที่มีอยู่
      ref: packages/engine/src/tools/agent.ts#editExecutor

    - id: whole
      lane: tool
      at: executor
      do: >-
        `create: true` ทำให้ข้อความหลังแก้คือ `new_str` ทั้งก้อน ไม่มี `old_str` ให้หา
        (ถ้าไฟล์มีอยู่แล้วและ model อ่านไว้ `create: true` จะเขียนทับทั้งไฟล์)
      ref: "packages/core/src/edit.ts#\"if (input['create'] === true) return { kind: 'applied', after: newStr };\""

    - use: edit-write-lands
      beat:
        title: VS Code สร้างไฟล์แล้วแชตแสดง diff
        text: Geno ส่งเนื้อหาให้ VS Code เขียน ขั้นของ edit บอกจำนวนบรรทัดที่เพิ่ม (การรันจริงข้างล่างสร้าง `src/clamp.ts` ยาว 4 บรรทัด ขั้นจึงขึ้น +4 −0) และท้าย turn มีการ์ดการเปลี่ยนแปลงให้รีวิว
        from: engine
        to: panel
        sees:
          kind: step
          label: Edited slug.ts
          status: done

    - id: result
      beat:
        title: Geno เตรียมผลว่าสร้างแล้ว
        text: Geno เขียนข้อความผลไว้ใน session log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร ใน `content` ของการ์ด ผลขึ้นต้นด้วย "Created" แทน "Edited" และบอกว่าไม่ต้องอ่านไฟล์ซ้ำ ในการรันจริงนี้ check ของโปรเจกต์ (คำสั่งตรวจที่ตั้งไว้ เช่นเทสต์ ที่ Geno รันเองหลังแก้ไฟล์สำเร็จ) ล้มเหลวจากเทสต์เดิม ผลจึงมีรายงานของ check ต่อท้าย
        from: engine
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A03-new-file-create/fix-a1/wire.jsonl#line=13
          select: messages[-1].content[0]
          highlight: [content]
      lane: tool
      at: executor
      do: >-
        ข้อความผลขึ้นต้นด้วย "Created src/slug.ts." แทน "Edited" และบอก model ว่าไม่ต้องอ่านไฟล์ซ้ำ
      ref: "packages/engine/src/tools/agent.ts#\"const editedText = \""

    - use: tool-result-returns

    - id: next
      beat:
        title: Geno เรียก model อีกครั้ง
        text: Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอ edit ของ model และผลที่ Geno เตรียมไว้ model จึงรู้ว่าสร้างไฟล์แล้ว ก่อนส่ง Geno เก็บ checkpoint (ภาพถ่ายไฟล์ใน workspace) ที่รวมไฟล์ใหม่นี้ไว้ ให้คุณย้อนการสร้างได้ภายหลัง การ์ดข้างล่างเป็นข้อความท้ายสุดของคำขอจริงจากการรันเดียวกับการ์ดแรก บทสนทนาก่อนหน้ายาวเกินกว่าจะแสดงทั้งหมด ในรอบนั้น model ขอ edit สามครั้งในคำตอบเดียว (Geno รันทีละตัว) ข้อความนี้จึงมีผลสามชิ้น ชิ้นแรกคือผลของการสร้าง `src/clamp.ts`
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A03-new-file-create/fix-a1/wire.jsonl#line=13
          select: messages[-1]
          highlight: ['content[0]']
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` checkpoint ถัดไปรวมไฟล์ใหม่นี้ด้วย
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: reply
      beat:
        title: Model ตอบหลังเห็นผล
        text: model ตอบหลังได้คำขอนี้เท่านั้น ในการ์ด ความคิดของ model พับไว้ ที่ไฮไลต์คือ input ของ `bash` ในการรันจริงนี้ model เห็นว่า check มีเทสต์ล้มเหลวสี่ตัว และคิดว่าเป็นเทสต์เดิมที่ล้มอยู่ก่อนแล้ว จึงขอรัน `bash` เพื่อดูว่าเทสต์ของไฟล์ใหม่ผ่านหรือไม่
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A03-new-file-create/fix-a1/session.jsonl#seq=28
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

หน้านี้เล่าว่า model สร้างไฟล์ใหม่อย่างไร เส้นทางเกือบเหมือน [แก้ไฟล์แล้วแสดงเป็น diff](/scenarios/edit/applied-as-diff/)
ต่างกันตรงที่ไม่ต้องอ่านไฟล์ก่อน และผลบอก model ว่า "Created"

Geno ไม่มี tool `write` แยก การสร้างไฟล์คือ `edit` ที่มี `create: true`
ถ้า model เรียก tool ชื่อ `write`, `create_file` หรือ `Write` ผลจะเป็น error ที่บอกให้ใช้ `edit` กับ `create: true` แทน

สิ่งที่ควรสังเกต

- **ไฟล์ใหม่ไม่ถูกเปิดในแท็บ** extension เขียนไฟล์ลงดิสก์แล้วเปิดเป็นเอกสารเบื้องหลังเพื่อติดตามการเปลี่ยนแปลง
  ผู้ใช้เปิดดูได้จากชิปไฟล์หรือการ์ดการเปลี่ยนแปลงในแผง
- **Undo ลบไฟล์ใหม่** Undo ของ turn คืน workspace เป็น [checkpoint](/start/glossary/) ก่อน turn ไฟล์ที่ turn สร้างจึงถูกลบ
  ดู [ดูการเปลี่ยนแปลงของ turn และ Undo](/scenarios/ed/review-auto-undo/)
