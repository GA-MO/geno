---
title: "สร้างไฟล์ใหม่ด้วย edit"
description: โมเดลเรียก edit ด้วย create true กับ path ที่ยังไม่มี Geno ไม่ต้องให้อ่านก่อน เขียนไฟล์ใหม่ผ่าน VS Code และแสดงเป็น diff
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto และไม่มี hook
    - ยังไม่มีไฟล์ `src/slug.ts` ใน workspace
  trigger: >-
    โมเดลขอเรียก `edit` ด้วย `path: src/slug.ts`, `create: true` และเนื้อหาทั้งไฟล์ใน `new_str`
  covers: [edit.create-file]
  related: [edit.applied-as-diff, ed.review-auto-undo, tool.unknown-or-invalid]
  steps:
    - id: asks
      beat:
        title: Model ขอสร้าง `src/slug.ts`
        text: "โมเดลเรียก edit ด้วย `create: true` และเนื้อหาทั้งไฟล์ใน `new_str` ไม่มี `old_str` เพราะยังไม่มีอะไรให้แทน การ์ดเป็นคำขอจริงจากการรันที่สร้าง `src/clamp.ts`"
        from: model
        to: engine
        sees:
          kind: payload
          direction: response
          source: docs/results/real-usecases/runs/A03-new-file-create/fix-a1/session.jsonl#seq=23
          select: content[2]
          highlight:
            - input.create
            - input.path
      lane: model
      do: >-
        โมเดลขอเรียก `edit` เพื่อสร้าง `src/slug.ts` ด้วย `create: true` และเนื้อหาทั้งไฟล์ แล้วจบคำตอบด้วย `stop_reason: tool_use`
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
        (ถ้าไฟล์มีอยู่แล้วและโมเดลอ่านไว้ `create: true` จะเขียนทับทั้งไฟล์)
      ref: "packages/core/src/edit.ts#\"if (input['create'] === true) return { kind: 'applied', after: newStr };\""

    - use: edit-write-lands
      beat:
        title: VS Code สร้างไฟล์แล้วแชตแสดง diff
        text: Geno ส่งเนื้อหาให้ VS Code เขียน ขั้นของ edit บอกจำนวนบรรทัดที่เพิ่ม และท้าย turn มีการ์ดการเปลี่ยนแปลงให้รีวิว
        from: engine
        to: panel
        sees:
          kind: step
          label: Edited slug.ts
          status: done
          note: "+12"

    - id: result
      beat:
        title: Geno บอก model ว่าสร้างแล้ว
        text: ผลขึ้นต้นด้วย "Created" แทน "Edited" และบอกโมเดลว่าไม่ต้องอ่านไฟล์ซ้ำ ในการรันจริงนี้ check ของโปรเจกต์ล้มเหลวจากเทสต์เดิม ผลจึงมีรายงานของ check ต่อท้าย
        from: engine
        to: model
        sees:
          kind: payload
          direction: tool_result
          source: docs/results/real-usecases/runs/A03-new-file-create/fix-a1/session.jsonl#seq=24
          select: output
      lane: tool
      at: executor
      do: >-
        ข้อความผลขึ้นต้นด้วย "Created src/slug.ts." แทน "Edited" และบอกโมเดลว่าไม่ต้องอ่านไฟล์ซ้ำ
      ref: "packages/engine/src/tools/agent.ts#\"const editedText = \""

    - use: tool-result-returns

    - id: next
      beat:
        title: Geno เรียก model อีกครั้ง
        text: checkpoint ถัดไปรวมไฟล์ใหม่นี้ คุณจึงย้อนการสร้างได้ แล้วโมเดลอ่านผลเพื่อทำงานต่อ
        from: engine
        to: model
        end: Model อ่านผลแล้วทำต่อ
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` checkpoint ถัดไปรวมไฟล์ใหม่นี้ด้วย
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

Geno ไม่มีเครื่องมือ `write` แยก การสร้างไฟล์คือ `edit` ที่มี `create: true`
ถ้าโมเดลเรียกเครื่องมือชื่อ `write`, `create_file` หรือ `Write` ผลจะเป็น error ที่บอกให้ใช้ `edit` กับ `create: true` แทน

สิ่งที่ควรสังเกต

- **ไฟล์ใหม่ไม่ถูกเปิดในแท็บ** extension เขียนไฟล์ลงดิสก์แล้วเปิดเป็นเอกสารเบื้องหลังเพื่อติดตามการเปลี่ยนแปลง
  ผู้ใช้เปิดดูได้จากชิปไฟล์หรือการ์ดการเปลี่ยนแปลงในแผง
- **Undo ลบไฟล์ใหม่** Undo ของ turn คืน workspace เป็น checkpoint ก่อน turn ไฟล์ที่ turn สร้างจึงถูกลบ
  ดู [ดูการเปลี่ยนแปลงของเทิร์นและ Undo](/scenarios/ed/review-auto-undo/)
