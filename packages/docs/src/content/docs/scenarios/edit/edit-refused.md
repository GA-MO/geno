---
title: การแก้ไฟล์ถูกปฏิเสธ
description: edit ไม่เขียนอะไรถ้าโมเดลยังไม่ได้อ่านไฟล์ ถ้าไฟล์เปลี่ยนไปหลังอ่าน หรือถ้า old_str ไม่ตรงกับที่เดียวในไฟล์ ผลบอกโมเดลว่าต้องทำอะไรต่อ
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto และ `src/date.ts` อยู่ใน workspace
    - ผู้ใช้เปิด `src/date.ts` ไว้ใน VS Code
  trigger: >-
    โมเดลขอเรียก `edit` กับ `src/date.ts` ด้วย `old_str` และ `new_str`
  covers: [edit.without-read-or-stale, edit.old-str-mismatch]
  related: [edit.applied-as-diff, edit.create-file, ctx.file-changed-on-disk]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอ `edit` ไฟล์ `src/date.ts` จบด้วย `stop_reason: tool_use`
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

    - id: current
      lane: server
      at: updates
      do: >-
        `edit` อ่านข้อความปัจจุบันของไฟล์ผ่าน `editorFiles` ซึ่งส่งคำขอ ACP `fs/readTextFile` เพราะมี editor แสดง session นี้อยู่
      ref: packages/engine/src/serve.ts#editorFiles

    - id: buffer
      lane: editor
      at: bridge
      do: >-
        `readTextFile` ให้ข้อความของ buffer ที่เปิดอยู่ รวมการแก้ที่ผู้ใช้ยังไม่บันทึก
      ref: packages/extension/src/chat/bridge.ts#readTextFile

    - id: check
      lane: tool
      at: executor
      do: >-
        `edit` หาฐานของการแก้: ข้อความที่โมเดลเห็นครั้งล่าสุดจาก `read` หรือจาก `edit` ก่อนหน้า (ในหน่วยความจำของรอบนี้ หรือจากบันทึกใน log)
        แล้วให้ `proposeChange` เทียบ hash ของฐานกับข้อความปัจจุบันก่อนลองแทนข้อความ
      ref: packages/core/src/edit.ts#proposeChange
      fork:
        ask: การแก้ติดตรงไหน
        options:
          - id: not-read
            label: โมเดลยังไม่ได้อ่านไฟล์
            then: failed
            steps:
              - lane: tool
                at: executor
                do: >-
                  `lastSeen` ไม่พบว่าโมเดลเคยเห็นไฟล์นี้ ทั้งในหน่วยความจำและใน log `edit` โยน `ToolError`
                  "read src/date.ts before editing it" ก่อนเทียบอะไร ไฟล์ใหม่ที่ยังไม่มีบนดิสก์ไม่ติดข้อนี้
                ref: "packages/engine/src/tools/agent.ts#\"if (base === undefined) throw new ToolError(`read ${input.path} before editing it`);\""
                emits: [ToolError]
          - id: stale
            label: ไฟล์เปลี่ยนหลังโมเดลอ่าน
            then: failed
            steps:
              - lane: tool
                at: executor
                do: >-
                  ผู้ใช้พิมพ์ใน buffer หลังจากโมเดลอ่านไฟล์ hash ของข้อความปัจจุบันจึงไม่ตรงกับฐาน `proposeChange` ล้มเหลวแบบ `stale-base`
                  ("src/date.ts changed since it was last read; read it again before editing") ไม่มีการแทนข้อความ
                ref: packages/core/src/edit.ts#staleBaseDetail
                emits: [stale-base]
          - id: zero
            label: old_str ไม่ตรงที่ไหนเลย
            then: failed
            steps:
              - lane: tool
                at: executor
                do: >-
                  `strReplace` หาแบบตรงตัวไม่พบ หาอีกครั้งแบบไม่สนการเยื้องและช่องว่างท้ายบรรทัดก็ไม่พบ
                  ผลบอกช่วงบรรทัดที่ใกล้ที่สุดพร้อมเลขบรรทัด และให้คัดลอก `old_str` จากไฟล์ตรงๆ
                  ("old_str does not appear in src/date.ts, even ignoring indentation and trailing whitespace. The closest text is lines 12-18: ...")
                ref: packages/core/src/str-replace.ts#strReplace
                emits: [zero-matches]
          - id: many
            label: old_str ตรงหลายที่
            then: failed
            steps:
              - lane: tool
                at: executor
                do: >-
                  `old_str` ตรงสองที่ในไฟล์ `strReplace` ไม่เดาว่าที่ไหน ผลบอกจำนวนและบรรทัดที่เริ่ม
                  และให้ใส่บรรทัดรอบข้างเพิ่ม หรือส่ง `replace_all: true` ถ้าตั้งใจแก้ทุกที่
                ref: "packages/core/src/str-replace.ts#\"function multiple(path: string, startLines: readonly number[], kind: keyof typeof MATCHES): ApplyOutcome {\""
                emits: [multiple-matches]

    - id: failed
      lane: tool
      at: executor
      do: >-
        ทุกทางจบด้วย `ToolError` ที่มีรายละเอียดนั้น ไม่มี `fs/writeTextFile` buffer ไม่เปลี่ยน และไม่มี diff หรือ hunk ให้รีวิว
      ref: "packages/engine/src/tools/agent.ts#\"if (proposed.result.kind === 'failed') throw new ToolError(proposed.result.detail);\""
      emits: [ToolError]

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ผลไปถึงโมเดลเป็น `is_error: true`
        โมเดลมักอ่านไฟล์ใหม่ แล้วส่ง `edit` อีกครั้งด้วยข้อความที่ตรง
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model, is_error]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

`edit` ยอมเขียนเฉพาะเมื่อมั่นใจว่าโมเดลแก้ข้อความที่มันเห็นจริง การปฏิเสธทุกแบบเป็น `ToolError` ธรรมดา
แผงแสดงขั้นเป็นล้มเหลว และ turn ทำงานต่อ

| เหตุ | ข้อความที่โมเดลได้ | ทางแก้ของโมเดล |
| --- | --- | --- |
| ยังไม่อ่าน | `read <path> before editing it` | `read` ก่อน |
| ไฟล์เปลี่ยนหลังอ่าน | `<path> changed since it was last read; read it again before editing` | `read` อีกครั้ง |
| `old_str` ไม่ตรง | บรรทัดที่ใกล้ที่สุดพร้อมเลขบรรทัด | คัดลอกข้อความตรงๆ |
| `old_str` ตรงหลายที่ | จำนวนและบรรทัดที่ตรง | ใส่บรรทัดรอบข้าง หรือ `replace_all` |

สิ่งที่ควรสังเกต

- **การแก้ที่ยังไม่บันทึกของผู้ใช้ชนะ** ฐานของการแก้เทียบกับ buffer ไม่ใช่ดิสก์ เมื่อผู้ใช้พิมพ์หลังโมเดลอ่าน `edit` ไม่ทับข้อความของผู้ใช้
  ส่วนขยายยังตรวจซ้ำอีกครั้งตอนเขียน ถ้า buffer เปลี่ยนระหว่างนั้น `writeTextFile` ตอบว่า stale และได้ผลแบบเดียวกัน
- **หาแบบหลวมได้ครั้งเดียว** ถ้าหาแบบตรงตัวไม่พบ `strReplace` ยอมรับการตรงแบบไม่สนการเยื้องเฉพาะเมื่อมีที่เดียว
- **ส่งการแก้ซ้ำไม่ผิด** ถ้า `old_str` หายไปแล้วแต่ `new_str` หลายบรรทัดอยู่ในไฟล์ที่เดียว `strReplace` ถือว่าการแก้นี้ทำไปแล้วและไม่เปลี่ยนอะไร
