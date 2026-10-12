---
title: "read อ่านรูป PDF notebook และไฟล์ไบนารี"
description: read ดูนามสกุลและเนื้อไฟล์ก่อนอ่าน รูปส่งให้โมเดลเป็นภาพ PDF และ notebook แบ่งเป็นหน้าหรือ cell ส่วนไฟล์ไบนารีถูกปฏิเสธ
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมดใดก็ได้ ไฟล์อยู่ใน workspace และไม่ใช่ไฟล์ลับ
  trigger: >-
    โมเดลขอเรียก `read` กับไฟล์ที่ไม่ใช่ข้อความธรรมดา เช่น `assets/logo.png`, `docs/spec.pdf`, `notebooks/eda.ipynb` หรือ `build/app.o`
  covers: [tool.read-special-files]
  related: [tool.parallel-read-batch, perm.secret-read, perm.read-outside-workspace]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขออ่านไฟล์ที่ไม่ใช่ข้อความ"
        text: >-
          โมเดลขอ `read` ไฟล์อย่าง `assets/logo.png`, `docs/spec.pdf`, `notebooks/eda.ipynb` หรือ `build/app.o` ถ้าเป็น
          PDF ระบุหน้าได้ ถ้าเป็น notebook ระบุ cell ได้
        from: model
        to: engine
      do: >-
        โมเดลขอ `read` ไฟล์หนึ่งไฟล์ (ใส่ `pages` ได้ถ้าเป็น PDF หรือ `cells` ถ้าเป็น notebook) จบด้วย `stop_reason: tool_use`
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
        title: "แชตขึ้นขั้นของ read"
        text: >-
          Geno บันทึกคำขอแล้วแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: read assets/logo.png, status: running }

    - id: kind
      lane: tool
      at: executor
      beat:
        title: "read ดูชนิดของไฟล์ก่อนอ่าน"
        text: >-
          read หา path จริงใน workspace ตรวจว่าไม่ใช่ไฟล์ลับ แล้วเลือกวิธีอ่าน โฟลเดอร์ถูกปฏิเสธ รูปและ PDF ดูจากนามสกุล
          ไฟล์อื่นอ่านเป็นข้อความก่อนแล้วตรวจไบต์ NUL ลองเลือกชนิดของไฟล์
        from: engine
        to: machine
        ask: "ไฟล์ชนิดไหน"
      do: >-
        `read` หา path จริงใน workspace ตรวจว่าไม่ใช่ไฟล์ลับ แล้ว `readResolved` เลือกวิธีอ่านจากชนิดของไฟล์:
        โฟลเดอร์ถูกปฏิเสธ ("use list") รูปและ PDF ดูจากนามสกุล ไฟล์อื่นอ่านเป็นข้อความก่อนแล้วตรวจไบต์ NUL
      ref: packages/engine/src/tools/read.ts#readResolved
      fork:
        ask: ไฟล์เป็นชนิดไหน
        options:
          - id: image
            label: รูป (.png .jpg .gif .webp)
            then: result
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "รูป Geno แนบภาพไปกับผล"
                  text: >-
                    Geno เก็บรูปไว้กับ session รูปละไม่เกิน 5 MB แล้วคืนข้อความสั้นที่บอกขนาดพร้อมรูป
                    ในแชตรูปขึ้นเป็นภาพย่อใต้ขั้นที่คลิกเปิดได้
                  from: engine
                  to: machine
                do: >-
                  `readImage` เก็บรูปลงที่เก็บไฟล์แนบของ session (รูปละไม่เกิน 5 MB) แล้วคืนข้อความสั้นพร้อมรูป
                  ("assets/logo.png is a 512x512 PNG image (34 KB), attached below.")
                  เมื่อผลไปถึงแผง รูปขึ้นใต้ขั้นของ `read` เป็นภาพย่อที่คลิกเปิดได้
                ref: packages/engine/src/tools/read.ts#readImage
          - id: pdf
            label: PDF
            then: result
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "PDF Geno คืนทีละหน้า"
                  text: >-
                    Geno คืน 10 หน้าแรกถ้าไม่ได้ระบุหน้า ครั้งละไม่เกิน 20 หน้า หน้าที่มีข้อความได้ข้อความ หน้าสแกนได้เป็นรูป
                    ท้ายผลบอกว่าจะอ่านหน้าต่อไปอย่างไร
                  from: engine
                  to: machine
                do: >-
                  `readPdf` เปิด PDF (ไม่เกิน 64 MB) และคืน 10 หน้าแรกถ้าไม่ได้ระบุ `pages` ครั้งละไม่เกิน 20 หน้า
                  หน้าที่มีข้อความได้ข้อความ หน้าสแกนที่ไม่มีชั้นข้อความได้เป็นรูป (ไม่เกิน 8 รูปต่อครั้ง)
                  ท้ายผลบอกว่าจะอ่านหน้าต่อไปอย่างไร
                ref: packages/engine/src/tools/read.ts#readPdf
          - id: notebook
            label: Jupyter notebook (.ipynb)
            then: result
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "Notebook Geno แบ่งเป็น cell"
                  text: >-
                    Geno อ่าน notebook ผ่าน VS Code จึงได้การแก้ที่ยังไม่บันทึกด้วย แล้วแยกเป็น cell ที่มีหัวข้อบอกลำดับ
                  from: engine
                  to: machine
                do: >-
                  `readNotebook` อ่านไฟล์ผ่าน editor (ได้การแก้ที่ยังไม่บันทึกด้วย) แยกเป็น cell แล้วคืนทุก cell
                  ถ้าไม่ได้ระบุ `cells` แต่ละ cell เป็นหนึ่งส่วนที่มีหัวข้อบอกลำดับ
                ref: packages/engine/src/tools/read.ts#readNotebook
          - id: binary
            label: ไฟล์ไบนารี
            then: result
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "ไฟล์ไบนารี Geno ไม่อ่าน"
                  text: >-
                    ช่วงต้นของไฟล์มีไบต์ NUL read จึงตอบว่าเป็นไฟล์ไบนารี ผลเป็น error และไม่มีเนื้อไฟล์
                  from: engine
                  to: machine
                do: >-
                  ข้อความช่วงต้นของไฟล์มีไบต์ NUL `read` จึงโยน `ToolError` ว่า "build/app.o is a binary file"
                  ผลมีสถานะ `error` และไม่มีเนื้อไฟล์
                ref: "packages/engine/src/tools/read.ts#\"is a binary file\""
                emits: [ToolError]

    - id: result
      lane: tool
      at: executor
      beat:
        title: "ผลของ read กลับมาที่แชต"
        text: >-
          รูปที่ได้ติดไปกับผลเป็นไฟล์แนบ ไม่ได้อยู่ในข้อความ Geno บันทึกผลแล้วขั้นในแชตหยุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: read assets/logo.png, status: done, output: "assets/logo.png is a 512x512 PNG image (34 KB), attached below." }
      do: >-
        ผลของ `read` พร้อมแล้ว รูปที่ได้ (ถ้ามี) ติดไปกับผลเป็นไฟล์แนบที่เก็บไว้ ไม่ได้อยู่ในข้อความ
      ref: packages/engine/src/tools/index.ts#runExecutor

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "Model เห็นภาพจริง"
        text: >-
          Geno เรียกโมเดลต่อ รูปไปถึงโมเดลเป็นบล็อกภาพในผลของ tool โมเดลที่อ่านรูปได้จึงเห็นภาพจริง
          ผลที่ล้มเหลวไปถึงพร้อมป้ายว่าเป็น error
        from: engine
        to: model
        end: "model ทำต่อ"
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` รูปไปถึงโมเดลเป็นบล็อก image ใน `tool_result`
        โมเดลที่อ่านรูปได้จึงเห็นภาพจริง ผลที่ล้มเหลวไปถึงเป็น `is_error: true`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

`read` ตัวเดียวอ่านไฟล์ได้หลายชนิด โมเดลไม่ต้องเลือก tool เอง

| ชนิด | ผล | ขีดจำกัด |
| --- | --- | --- |
| รูป | ข้อความสั้นและรูป | รูปละ 5 MB |
| PDF | ข้อความทีละหน้า หน้าสแกนเป็นรูป | 10 หน้าถ้าไม่ระบุ สูงสุด 20 หน้าต่อครั้ง ไฟล์ 64 MB |
| notebook | ทีละ cell | ไฟล์ 64 MB |
| ข้อความ | บรรทัดมีเลขกำกับ | หน้าแรกถ้ายาว แล้วบอกวิธีอ่านต่อ |
| ไบนารี | ปฏิเสธ | |
| โฟลเดอร์ | ปฏิเสธ ให้ใช้ `list` | |

สิ่งที่ควรสังเกต

- **notebook กับข้อความผ่าน editor รูปและ PDF อ่านจากดิสก์** `read` ของ notebook และไฟล์ข้อความใช้ `ctx.files.read`
  ซึ่งได้ buffer ที่เปิดอยู่ใน VS Code ส่วนรูปและ PDF อ่านไบต์จากดิสก์ตรงๆ
- **notebook ที่ระบุบรรทัดอ่านเป็น JSON** ถ้าส่ง `start_line` หรือ `end_line` มากับไฟล์ `.ipynb` `read` อ่านเป็นข้อความธรรมดา
- **ไฟล์ลับยังผ่านด่านก่อน** ชนิดของไฟล์ไม่ได้ข้ามการตรวจไฟล์ลับ ดู [Model อ่านไฟล์ลับอย่าง .env](/scenarios/perm/secret-read/)

ไฟล์ลับและไฟล์นอก workspace ดู [Model อ่านไฟล์ลับอย่าง .env](/scenarios/perm/secret-read/)
