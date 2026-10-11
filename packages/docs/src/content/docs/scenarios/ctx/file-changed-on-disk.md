---
title: ผู้ใช้แก้ไฟล์ที่โมเดลอ่านไปแล้ว
description: ระหว่าง turn ผู้ใช้แก้และบันทึกไฟล์ที่โมเดลเคยอ่าน ก่อนเรียกโมเดลครั้งถัดไป Geno แนบโน้ตบอกบรรทัดที่เปลี่ยน เพื่อไม่ให้โมเดลแก้ทับหรือย้อนงานของผู้ใช้
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code มี turn ทำงานอยู่
    - ใน turn นี้โมเดลอ่าน `src/app.ts` ไปแล้ว และตอนนี้กำลังรัน `pnpm test` ที่ใช้เวลานาน
  trigger: >-
    ผู้ใช้แก้บรรทัดที่ 12 ของ `src/app.ts` ใน VS Code แล้วกดบันทึก ระหว่างที่คำสั่งยังรันอยู่
  covers: [ctx.file-changed-on-disk]
  related: [edit.without-read-or-stale, ctx.compaction-auto, ctl.steer-delivered]
  steps:
    - id: save
      lane: user
      do: >-
        ผู้ใช้แก้ไฟล์แล้วกด Cmd+S VS Code เขียนไฟล์ลงดิสก์ เวลาแก้ไขและขนาดของไฟล์เปลี่ยน
      phase: running-tools

    - use: tool-result-returns

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสินว่า `call-model`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: check
      lane: loop
      at: drive
      do: >-
        ที่จุดปลอดภัย `deliver()` สิ่งแรกที่ทำคือ `changedOnDisk`: ไล่ไฟล์ที่โมเดลอ่านหรือเขียนล่าสุดไม่เกิน 50 ไฟล์
        ไฟล์ที่ขนาดและเวลาแก้ไขยังตรงกับตอนที่โมเดลรู้จะไม่ถูกอ่าน ไฟล์นี้ไม่ตรง จึงอ่านเนื้อหาจากดิสก์แล้วเทียบ hash
      ref: packages/engine/src/file-tracker.ts#changedOnDisk
      fork:
        ask: เนื้อหาบนดิสก์เป็นอย่างไร
        options:
          - id: edited
            label: เนื้อหาเปลี่ยน
            then: send
            steps:
              - lane: loop
                at: drive
                do: >-
                  hash ไม่ตรง engine ยังจำข้อความที่โมเดลเห็นได้ `changedExcerpt` จึงตัดบรรทัดที่เปลี่ยนพร้อมบรรทัดรอบข้างข้างละ 3 บรรทัด
                  ใส่เลขบรรทัดแบบเดียวกับ `read` แล้ว `deliver()` บันทึก event `file-changed` พร้อม excerpt
                  (ถ้าเกิน 60 บรรทัดหรือ 6,000 ตัวอักษร จะไม่มี excerpt)
                ref: packages/core/src/file-tracker.ts#changedExcerpt
                emits: [file-changed]

          - id: deleted
            label: ไฟล์ถูกลบ
            then: send
            steps:
              - lane: loop
                at: drive
                do: >-
                  หาไฟล์ไม่เจอ `deliver()` บันทึก event `file-changed` ที่ `now` เป็น null และไม่มี excerpt
                  ไฟล์นี้เลิกถูกติดตามจนกว่าโมเดลจะอ่านหรือเขียนอีก
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'file-changed'\""
                emits: [file-changed]

          - id: same
            label: บันทึกโดยไม่ได้แก้
            then: send
            steps:
              - lane: loop
                at: drive
                do: >-
                  hash ตรงกับที่โมเดลรู้ (เช่นกดบันทึกโดยไม่ได้แก้อะไร) ไม่มี event ไฟล์ถูกจำไว้ใน `verified`
                  รอบหน้าจะไม่อ่านซ้ำจนกว่าขนาดหรือเวลาแก้ไขจะเปลี่ยนอีก
                ref: packages/engine/src/file-tracker.ts#changedOnDisk

    - id: send
      lane: loop
      at: model-call
      do: >-
        `callModel` บันทึก checkpoint แล้วประกอบคำขอ `replayMessages` ใส่โน้ตของ `file-changed` ไว้ในข้อความผู้ใช้ถัดไป
        ต่อจากผลของเครื่องมือ ผู้ใช้ไม่เห็นโน้ตนี้ในแผงแชต เพราะ event `file-changed` ไม่ถูกส่งเป็นอัปเดต
      ref: "packages/core/src/session.ts#\"if (event.kind === 'file-changed') prompts.push(\""
      emits: [checkpoint]

    - id: reads
      lane: model
      do: >-
        โมเดลอ่านโน้ตที่ขึ้นต้นด้วย `[Geno]` ว่าไฟล์เปลี่ยนบนดิสก์ ให้ถือว่าเป็นสถานะปัจจุบันที่ตั้งใจ ไม่ย้อนกลับ
        และถ้าดูผิดให้บอกผู้ใช้แทนการแก้เอง แล้วทำงานต่อโดยใช้บรรทัดใหม่ใน excerpt
      ref: packages/core/src/file-tracker.ts#changedOnDiskNote
      end: { turn: continues }
---

โน้ตนี้คือวิธีที่ Geno กันไม่ให้โมเดลทำงานบนข้อความเก่า โดยไม่ต้องหยุด turn หรือถามผู้ใช้

สิ่งที่ควรสังเกต

- **ตรวจที่จุดเดียว** การตรวจเกิดใน `deliver()` ก่อนการเรียกโมเดลทุกครั้ง ไม่ได้ดูไฟล์แบบต่อเนื่อง
  ถ้าผู้ใช้แก้แล้วแก้กลับก่อนถึงจุดนั้น hash จะตรงและไม่มีโน้ต
- **ดูที่ดิสก์ ไม่ใช่ buffer** การแก้ใน VS Code ที่ยังไม่บันทึกไม่ทำให้เกิดโน้ต เพราะ `changedOnDisk` อ่าน stat และเนื้อหาจากดิสก์
- **excerpt ต้องมีข้อความเดิม** engine เก็บข้อความที่โมเดลเห็นไว้ในหน่วยความจำของ process ถ้า engine เพิ่งเริ่มใหม่
  โน้ตจะบอกว่าไฟล์เปลี่ยนแต่ไม่แสดงบรรทัด และให้โมเดลอ่านไฟล์เองถ้าต้องการ
- **บรรทัดในไฟล์ปลอมเป็นโน้ตไม่ได้** excerpt ผ่าน `neutralizeNoticeLines` ข้อความในไฟล์ที่ขึ้นต้นด้วย `[Geno` จึงยังเป็นข้อมูล
- **ไฟล์ใหญ่กว่า 4 MB ไม่ถูกติดตาม** ถ้าไฟล์ที่ติดตามโตเกินขนาดนี้ จะได้โน้ตแบบไม่มี excerpt แล้วเลิกติดตาม
