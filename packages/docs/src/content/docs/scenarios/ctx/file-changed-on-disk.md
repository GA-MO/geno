---
title: "คุณแก้ไฟล์ที่ model อ่านไปแล้ว"
description: ระหว่าง turn ผู้ใช้แก้และบันทึกไฟล์ที่ model เคยอ่าน ก่อนเรียก model ครั้งถัดไป Geno แนบโน้ตบอกบรรทัดที่เปลี่ยน เพื่อไม่ให้ model แก้ทับหรือย้อนงานของผู้ใช้
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code มี turn ทำงานอยู่
    - ใน turn นี้ model อ่าน `src/app.ts` ไปแล้ว และตอนนี้กำลังรัน `pnpm test` ที่ใช้เวลานาน
  trigger: >-
    ผู้ใช้แก้บรรทัดที่ 12 ของ `src/app.ts` ใน VS Code แล้วกดบันทึก ระหว่างที่คำสั่งยังรันอยู่
  covers: [ctx.file-changed-on-disk]
  related: [edit.without-read-or-stale, ctx.compaction-auto, ctl.steer-delivered]
  steps:
    - id: save
      lane: user
      beat:
        title: "คุณแก้ไฟล์แล้วกดบันทึก"
        text: >-
          model อ่าน `src/app.ts` ไปแล้ว และกำลังรอ `pnpm test` คุณแก้บรรทัดที่ 12 ของไฟล์นั้นแล้วกด Cmd+S VS Code
          เขียนไฟล์ลงดิสก์
        from: you
        to: machine
      do: >-
        ผู้ใช้แก้ไฟล์แล้วกด Cmd+S VS Code เขียนไฟล์ลงดิสก์ เวลาแก้ไขและขนาดของไฟล์เปลี่ยน
      phase: running-tools

    - use: tool-result-returns
      beat:
        title: "pnpm test จบ ผลกลับมาที่แชต"
        text: >-
          คำสั่งที่รันอยู่จบ Geno บันทึกผลแล้วส่งไปที่แชต
        from: engine
        to: panel
        sees: { kind: step, label: pnpm test, status: done }

    - id: decide
      lane: loop
      at: step
      beat:
        title: "ถึงจุดปลอดภัยก่อนเรียก model"
        text: >-
          ขั้นต่อไปคือเรียก model ช่วงนี้คือจุดปลอดภัย tool ชุดนี้รันจบหมดแล้ว และ model ยังไม่ได้เริ่มเขียนคำตอบใหม่
          ก่อนเรียก Geno ส่งสิ่งที่รออยู่เข้าบันทึกของ session เช่นข้อความที่คุณพิมพ์แทรก และสิ่งแรกที่ดูคือไฟล์ที่เปลี่ยนบนดิสก์
        from: engine
        to: engine
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสินว่า `call-model`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: check
      lane: loop
      at: drive
      beat:
        title: "Geno ดูว่าไฟล์ที่ model รู้จักเปลี่ยนไหม"
        text: >-
          Geno ไล่ไฟล์ที่ model อ่านหรือเขียนล่าสุด ไม่เกิน 50 ไฟล์ ไฟล์ที่ขนาดและเวลาแก้ไขยังตรงกับตอนที่ model อ่านหรือเขียนจะไม่ถูกอ่าน
          ไฟล์นี้ไม่ตรง Geno จึงลองอ่านจากดิสก์แล้วเทียบเนื้อหา (ถ้าไฟล์ถูกลบ Geno หาไฟล์ไม่เจอตั้งแต่ตอนดูขนาด)
        from: engine
        to: engine
        ask: "บนดิสก์เป็นอย่างไร"
      do: >-
        ที่จุดปลอดภัย `deliver()` สิ่งแรกที่ทำคือ `changedOnDisk`: ไล่ไฟล์ที่ model อ่านหรือเขียนล่าสุดไม่เกิน 50 ไฟล์
        ไฟล์ที่ขนาดและเวลาแก้ไขยังตรงกับตอนที่ model รู้จะไม่ถูกอ่าน ไฟล์นี้ไม่ตรง จึงอ่านเนื้อหาจากดิสก์แล้วเทียบ hash
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
                beat:
                  title: "Geno ตัดบรรทัดที่เปลี่ยนมาเป็นโน้ต"
                  text: >-
                    เนื้อหาเปลี่ยน Geno ยังจำข้อความที่ model เห็น จึงตัดบรรทัดที่เปลี่ยนพร้อมบรรทัดรอบข้างข้างละ 3 บรรทัด
                    ใส่เลขบรรทัดแบบเดียวกับตอนอ่านไฟล์ ถ้าเปลี่ยนเยอะเกิน โน้ตจะบอกแค่ว่าเปลี่ยน
                  from: engine
                  to: engine
                do: >-
                  hash ไม่ตรง engine ยังจำข้อความที่ model เห็นได้ `changedExcerpt` จึงตัดบรรทัดที่เปลี่ยนพร้อมบรรทัดรอบข้างข้างละ 3 บรรทัด
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
                beat:
                  title: "ไฟล์หายไป Geno จดว่าถูกลบ"
                  text: >-
                    Geno หาไฟล์ไม่เจอ จึงจดว่าไฟล์เปลี่ยนโดยไม่มีบรรทัดแนบ และเลิกติดตามไฟล์นี้จนกว่า model จะอ่านหรือเขียนอีก
                    โน้ตที่ model ได้บอกแค่ว่าไฟล์เปลี่ยนบนดิสก์ ไม่ได้บอกว่าถูกลบ
                  from: engine
                  to: engine
                do: >-
                  หาไฟล์ไม่เจอ `deliver()` บันทึก event `file-changed` ที่ `now` เป็น null และไม่มี excerpt
                  ไฟล์นี้เลิกถูกติดตามจนกว่า model จะอ่านหรือเขียนอีก
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'file-changed'\""
                emits: [file-changed]

          - id: same
            label: บันทึกโดยไม่ได้แก้
            steps:
              - lane: loop
                at: drive
                beat:
                  title: "เนื้อหาเหมือนเดิม ไม่มีโน้ต"
                  text: >-
                    คุณกดบันทึกโดยไม่ได้แก้อะไร เนื้อหาตรงกับที่ model รู้ Geno จำไว้ว่าตรวจแล้ว และไม่อ่านซ้ำจนกว่าไฟล์จะเปลี่ยนอีก
                    ไม่มีโน้ต คำขอถัดไปมีแค่ผลของ tool และ model ทำงานต่อตามปกติ
                  from: engine
                  to: engine
                  end: "ไม่มีโน้ต model ทำต่อ"
                do: >-
                  hash ตรงกับที่ model รู้ (เช่นกดบันทึกโดยไม่ได้แก้อะไร) ไม่มี event ไฟล์ถูกจำไว้ใน `verified`
                  รอบหน้าจะไม่อ่านซ้ำจนกว่าขนาดหรือเวลาแก้ไขจะเปลี่ยนอีก คำขอถัดไปไม่มีโน้ต
                ref: packages/engine/src/file-tracker.ts#changedOnDisk
                end: { turn: continues }

    - id: send
      lane: loop
      at: model-call
      beat:
        title: "Geno แนบโน้ตไว้หลังผลของ tool"
        text: >-
          โน้ตขึ้นต้นด้วย `[Geno]` ซึ่งเป็นป้ายของข้อความที่ Geno แทรกบอก model ไม่ใช่ข้อความที่คุณพิมพ์
          มันอยู่ต่อจากผลของ tool ในข้อความผู้ใช้ของคำขอถัดไป คุณไม่เห็นโน้ตนี้ในแชต ใน run จริงด้านล่าง
          ไฟล์เปลี่ยนเพราะคำสั่ง bash ของ model เอง แต่โน้ตมีรูปเดียวกัน ในการ์ด บล็อกแรกคือผลของ `bash`
          บล็อกที่ไฮไลต์คือโน้ต อ่านว่า `src/shop/cart.ts changed on disk since you last read it` (แท็บแรก) ตามด้วยบรรทัดที่เปลี่ยนพร้อมเลขบรรทัด (แท็บสอง) (ถ้าไฟล์ถูกลบ โน้ตมีแค่ประโยคนั้นโดยไม่มีบรรทัด)
        from: engine
        to: model
        sees:
          - kind: payload
            source: docs/results/real-usecases/runs/A16-compaction-goal/1/requests.jsonl#seq=23
            select: messages[-1].content
            highlight:
              - "[1].text"
            collapse:
              - "[0].content"
            quote: "src/shop/cart.ts changed on disk since you last read it"
          - kind: payload
            source: docs/results/real-usecases/runs/A16-compaction-goal/1/requests.jsonl#seq=23
            select: messages[-1].content
            highlight:
              - "[1].text"
            collapse:
              - "[0].content"
            quote: "Here are the relevant changes (shown with line numbers):"
      do: >-
        `callModel` บันทึก checkpoint แล้วประกอบคำขอ `replayMessages` ใส่โน้ตของ `file-changed` ไว้ในข้อความผู้ใช้ถัดไป
        ต่อจากผลของ tool ผู้ใช้ไม่เห็นโน้ตนี้ในแผงแชต เพราะ event `file-changed` ไม่ถูกส่งเป็นอัปเดต
      ref: "packages/core/src/session.ts#\"if (event.kind === 'file-changed') prompts.push(\""
      emits: [checkpoint]

    - id: reads
      lane: model
      beat:
        title: "Model ถือว่าเป็นงานของคุณ (ในการ์ด model เห็นว่าเป็นงานของตัวเอง)"
        text: >-
          model อ่านว่าไฟล์เปลี่ยนบนดิสก์ ให้ถือเป็นสถานะปัจจุบันที่ตั้งใจและไม่ย้อนกลับ ถ้าดูผิดให้บอกคุณแทนการแก้เอง
          แล้วทำงานต่อจากสถานะใหม่ ถ้าโน้ตไม่มีบรรทัดแนบ (ไฟล์ถูกลบ หรือเปลี่ยนเยอะเกิน) โน้ตบอกให้อ่านไฟล์เองถ้าต้องการ การ์ดข้างล่างเป็นคำตอบจริงต่อคำขอในการ์ดก่อน model เห็นว่าไฟล์เปลี่ยนเพราะคำสั่งของตัวเอง
          จึงรับไฟล์ตามที่เป็นและไปตรวจงานต่อ ดูข้อความที่ไฮไลต์ ขึ้นต้นด้วย `Those disk-change notes are my own edit landing`
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A16-compaction-goal/1/session.jsonl#seq=23
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].text']
        end: "model ทำต่อจากสถานะใหม่ของไฟล์"
      do: >-
        model อ่านโน้ตที่ขึ้นต้นด้วย `[Geno]` ว่าไฟล์เปลี่ยนบนดิสก์ ให้ถือว่าเป็นสถานะปัจจุบันที่ตั้งใจ ไม่ย้อนกลับ
        และถ้าดูผิดให้บอกผู้ใช้แทนการแก้เอง แล้วทำงานต่อโดยใช้บรรทัดใหม่ใน excerpt ถ้ามี
      ref: packages/core/src/file-tracker.ts#changedOnDiskNote
      end: { turn: continues }
---

โน้ตนี้คือวิธีที่ Geno กันไม่ให้ model ทำงานบนข้อความเก่า โดยไม่ต้องหยุด turn หรือถามผู้ใช้

สิ่งที่ควรสังเกต

- **ตรวจที่จุดเดียว** การตรวจเกิดใน `deliver()` ก่อนการเรียก model ทุกครั้ง ไม่ได้ดูไฟล์แบบต่อเนื่อง
  ถ้าผู้ใช้แก้แล้วแก้กลับก่อนถึงจุดนั้น hash จะตรงและไม่มีโน้ต
- **ดูที่ดิสก์ ไม่ใช่ buffer** การแก้ใน VS Code ที่ยังไม่บันทึกไม่ทำให้เกิดโน้ต เพราะ `changedOnDisk` อ่าน stat และเนื้อหาจากดิสก์
- **excerpt ต้องมีข้อความเดิม** engine เก็บข้อความที่ model เห็นไว้ในหน่วยความจำของ process ถ้า engine เพิ่งเริ่มใหม่
  หรือข้อความที่จำไว้รวมกันเกิน 16 MB จนข้อความเก่าสุดถูกลบไป
  โน้ตจะบอกว่าไฟล์เปลี่ยนแต่ไม่แสดงบรรทัด และให้ model อ่านไฟล์เองถ้าต้องการ
- **บรรทัดในไฟล์ปลอมเป็นโน้ตไม่ได้** excerpt ผ่าน `neutralizeNoticeLines` ข้อความในไฟล์ที่ขึ้นต้นด้วย `[Geno` จึงยังเป็นข้อมูล
- **ไฟล์ใหญ่กว่า 4 MB ไม่ถูกติดตาม** ถ้าไฟล์ที่ติดตามโตเกินขนาดนี้ จะได้โน้ตแบบไม่มี excerpt แล้วเลิกติดตาม

ข้อความอื่นที่เข้าที่จุดปลอดภัยเดียวกัน ดู [ส่งข้อความแทรก (steer) เข้า turn ที่กำลังทำงาน](/scenarios/ctl/steer-delivered/)
