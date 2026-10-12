---
title: บันทึกคำตอบเป็นหน้า HTML
description: ผู้ใช้เลือก Save as page บนข้อความหนึ่ง ส่วนขยายสร้างไฟล์ HTML ไฟล์เดียวจากคำตอบของ turn นั้น พร้อมรูปและแผนภาพ แล้วบันทึกลงโฟลเดอร์ของ workspace ไม่มีอะไรถูกอัปโหลด
tableOfContents: false
sidebar:
  order: 8
scenario:
  surface: vscode
  given:
    - turn ก่อนหน้าจบแล้ว คำตอบมีตาราง แผนภาพ Mermaid ที่แผงวาดไว้ และรูปจาก workspace
    - การตั้งค่า `gcode.pages.folder` เป็นค่าเริ่มต้น `geno-pages`
  trigger: >-
    ผู้ใช้เปิดเมนูของข้อความแล้วเลือก Save as page
  covers: [sess.save-page]
  related: [sess.rewind, sess.history-manage]
  steps:
    - id: menu
      beat:
        title: คุณเลือก Save as page
        text: คำตอบมีตาราง แผนภาพ และรูป เมนูของข้อความมีรายการบันทึกเป็นหน้า HTML
        sees: รายการ "Save as page" กับคำอธิบาย "The answer as one HTML file to show someone"
      lane: panel
      at: rail
      do: >-
        เมนูของข้อความมีการย้อน การ fork บทและ Save as page
      sees: รายการ "Save as page" กับคำอธิบาย "The answer as one HTML file to show someone"
      ref: packages/extension/src/chat/rewind-view.ts#rewindMenu
      phase: idle

    - id: choose
      lane: user
      do: ผู้ใช้เลือก Save as page

    - id: post
      beat:
        title: แผงส่งแผนภาพที่วาดไว้แล้ว
        text: แผงส่งแผนภาพตามที่เห็นตอนนี้พร้อมธีมสี หน้า HTML จึงไม่ต้องวาดเอง
      lane: panel
      at: rail
      do: >-
        แผงโพสต์ `save-page` ที่มี id ของ turn และแผนภาพที่แผงวาดไว้แล้วตามที่เห็นตอนนี้ (SVG และธีมสี)
        หน้า HTML จึงไม่ต้องวาดแผนภาพเอง
      ref: "packages/extension/src/chat/webview.ts#\"const saveAnswer = (turnId: string, shell: HTMLElement): void =>\""
      emits: [save-page]

    - id: draft
      beat:
        title: ส่วนขยายประกอบหน้า HTML
        text: ส่วนขยายดึงคำตอบของ turn นั้น อ่านรูปจาก workspace ฝังเข้าไปในไฟล์เดียว ไม่มีอะไรถูกอัปโหลด
      lane: editor
      at: chat
      do: >-
        `pageHost.save` ให้ `pageDraft` ดึงคำตอบของ turn จากบทสนทนาในส่วนขยาย ถ้าไม่มีอะไรให้บันทึกจะเตือนแล้วหยุด
        รูปจาก workspace ถูกอ่านเป็น data URI (รูปละไม่เกิน 5 MB รวมไม่เกิน 20 MB) แล้ว `renderPage` เขียน HTML ไฟล์เดียว
      ref: packages/extension/src/chat/page-host.ts#pageHost

    - id: target
      beat:
        title: ส่วนขยายเลือกชื่อไฟล์
        text: ชื่อไฟล์มาจากหัวข้อของคำตอบ ที่อยู่คือ `geno-pages/` ในโฟลเดอร์แรกของ workspace
        ask: มีไฟล์ชื่อนี้ไหม
      lane: editor
      at: vscode-ui
      do: >-
        ชื่อไฟล์มาจากหัวข้อของคำตอบ ที่อยู่คือ `geno-pages/<ชื่อ>.html` ในโฟลเดอร์แรกของ workspace
        (ไม่มี workspace จะเปิดหน้าต่าง Save ของ VS Code แทน)
      ref: "packages/extension/src/chat/page-host.ts#\"async function targetFor(title: string): Promise<vscode.Uri | undefined> {\""
      fork:
        ask: มีไฟล์ชื่อนี้อยู่แล้วไหม
        options:
          - id: new
            label: ยังไม่มี
            then: write

          - id: clash
            label: มีแล้ว
            then: write
            steps:
              - lane: editor
                beat:
                  title: VS Code ถามว่าจะเขียนทับไหม
                  text: Keep Both บันทึกเป็นชื่อใหม่ที่บอกไว้ในคำถาม
                  sees: '"geno-pages/leap-year-fix.html already exists. Replace it?" ปุ่ม [Replace] [Keep Both] และ Cancel'
                at: vscode-ui
                do: >-
                  VS Code ถามแบบ modal ว่าจะเขียนทับหรือเก็บทั้งสอง Keep Both บันทึกเป็นชื่อใหม่ที่บอกไว้ในคำถาม
                sees: >-
                  "geno-pages/leap-year-fix.html already exists. Replace it?" ปุ่ม [Replace] [Keep Both] และ Cancel
                ref: "packages/extension/src/chat/page-host.ts#\"already exists. Replace it?\""
              - lane: user
                beat:
                  title: คุณกด Keep Both
                  text: ไฟล์เดิมไม่ถูกแตะ
                  to: panel
                do: ผู้ใช้กด Keep Both

    - id: write
      beat:
        title: ส่วนขยายเขียนไฟล์
        text: ส่วนขยายเขียนผ่าน filesystem ของ VS Code ไม่ผ่าน engine และไม่มี turn ใหม่
      lane: editor
      at: vscode-ui
      do: >-
        ส่วนขยายสร้างโฟลเดอร์ (ถ้ายังไม่มี) แล้วเขียนไฟล์ผ่าน filesystem ของ VS Code ไม่ผ่าน engine ไม่มี turn ใหม่
      ref: packages/extension/src/chat/page-host.ts#pageHost

    - id: saved
      beat:
        title: toast บอกที่อยู่ของไฟล์
        text: เปิดหน้าใน browser หรือเปิดโฟลเดอร์ได้จาก toast
        sees:
          kind: toast
          text: Saved the page to geno-pages/leap-year-fix-2.html.
          actions:
            - Open in Browser
            - Reveal in Finder
        end: หน้า HTML พร้อมส่ง
      lane: editor
      at: vscode-ui
      do: >-
        toast ของ VS Code บอกที่อยู่ของไฟล์ พร้อมปุ่มเปิดใน browser หรือเปิดโฟลเดอร์
      sees: >-
        "Saved the page to geno-pages/leap-year-fix-2.html." ปุ่ม [Open in Browser] [Reveal in Finder]
      ref: "packages/extension/src/chat/page-host.ts#\"async function offer(target: vscode.Uri): Promise<void> {\""
      end: { turn: none }
---

Save as page ทำงานในส่วนขยายทั้งหมด engine และโมเดลไม่รู้เรื่อง สิ่งที่ได้คือไฟล์ HTML ไฟล์เดียวที่เปิดได้โดยไม่ต้องต่อเน็ต
เพราะรูป แผนภาพ และสไตล์อยู่ในไฟล์นั้น

สิ่งที่ควรสังเกต

- **ไม่มีการอัปโหลด** ไฟล์อยู่ในโฟลเดอร์ของ workspace ผู้ใช้เป็นคนส่งต่อเอง
- **แผนภาพตามที่เห็น** หน้าเก็บ SVG ที่แผงวาดไว้ตอนกดบันทึก ไม่วาดใหม่ แผนภาพที่ใหญ่เกิน 2 MB ไม่ถูกเก็บ
- **รูปนอก workspace ไม่ถูกเก็บ** และรูปที่ทำให้ขนาดรวมเกิน 20 MB ถูกข้าม
- **ตั้งโฟลเดอร์เองได้** `gcode.pages.folder` รับ path สัมพัทธ์ใน workspace ค่าที่ออกนอก workspace กลับไปใช้ `geno-pages`
