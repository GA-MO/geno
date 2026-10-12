---
title: Tab เติมโค้ด
description: ขณะผู้ใช้พิมพ์ ส่วนขยายสร้าง prompt แบบ fill-in-the-middle ส่งให้ llama-server บนเครื่อง กรองผล แล้วแสดงเป็น ghost text ที่กด Tab รับได้ ไม่มี engine เกี่ยวข้อง
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - "`gcode.tab.enabled` เปิดอยู่ และ llama-server ที่ `gcode.tab.endpoint` พร้อมแล้ว แถบสถานะขึ้น Tab พร้อมไอคอน sparkle"
    - ผู้ใช้เปิด `src/date.ts` และไฟล์อื่นอีกสองสามไฟล์ใน editor
  trigger: >-
    ผู้ใช้พิมพ์ `export function isWeekend(` ใน `src/date.ts` แล้วหยุดพิมพ์ครู่หนึ่ง
  covers: [ed.tab-completion]
  related: [ed.inline-edit-cmd-k, start.open-window]
  steps:
    - id: type
      beat:
        title: คุณพิมพ์แล้วหยุด
        text: คุณพิมพ์ `export function isWeekend(` แล้วหยุดครู่หนึ่ง VS Code ขอคำเติม
        from: you
        to: panel
      lane: user
      do: ผู้ใช้พิมพ์แล้วหยุด
      phase: idle

    - id: ask
      beat:
        title: ส่วนขยายส่งคำขอให้ llama-server
        text: ส่วนขยายสร้าง prompt จากข้อความก่อนและหลังเคอร์เซอร์ และไฟล์อื่นที่เปิดอยู่ แล้วรอจนคุณหยุดพิมพ์ ไม่มี engine เกี่ยวข้อง
        from: panel
        to: model
      lane: editor
      at: vscode-ui
      do: >-
        VS Code ขอ inline completion `TabProvider` สร้าง prompt แบบ fill-in-the-middle จากข้อความก่อนเคอร์เซอร์ ข้อความหลังเคอร์เซอร์
        และไฟล์อื่นที่เปิดอยู่ (ไฟล์ที่มองเห็นก่อน) ถ้ามีผลที่ขอไปแล้วซึ่งขึ้นต้นด้วยสิ่งที่ผู้ใช้เพิ่งพิมพ์ ใช้ผลนั้นต่อโดยไม่ถามใหม่
      ref: packages/extension/src/tab/provider.ts#TabProvider.provideInlineCompletionItems

    - id: send
      lane: editor
      at: vscode-ui
      do: >-
        ไม่มีผลเดิมให้ใช้ `#ask` รอให้ผู้ใช้หยุดพิมพ์ตามเวลา debounce แล้ว `streamFim` ส่งคำขอ HTTP `/completion` ไปที่ llama-server
        ถ้าผู้ใช้พิมพ์ต่อระหว่างนั้น VS Code ยกเลิกการขอ completion ครั้งนี้ คำขอ HTTP ยัง stream ต่ออีก 100 ms
        ให้การขอครั้งถัดไปที่ตรงกับต้นของผลรับช่วงได้ ถ้าไม่มีใครรับ มันจึงถูกยกเลิก
      ref: packages/core/src/tab/stream.ts#streamFim

    - id: complete
      beat:
        title: llama-server บนเครื่องเติมโค้ด
        text: model เติมโค้ดขนาดเล็กบนเครื่องของคุณ stream ข้อความที่ควรอยู่ตรงเคอร์เซอร์กลับมา
        from: model
        to: panel
      lane: model
      do: >-
        llama-server บนเครื่องรัน model เติมโค้ดขนาดเล็กแล้ว stream ข้อความที่ควรอยู่ตรงเคอร์เซอร์กลับมา
      ref: packages/extension/src/tab/server.ts#TabServer

    - id: filter
      beat:
        title: ส่วนขยายกรองผล
        text: ผลถูกทิ้งถ้าคุณขยับเคอร์เซอร์ไปแล้ว ผลว่าง บรรทัดแรกซ้ำข้อความหลังเคอร์เซอร์ หรือยาวเกิน 8 บรรทัด
        from: panel
        to: panel
        ask: ผ่านตัวกรองไหม
      lane: editor
      at: vscode-ui
      do: >-
        `firstFilter` ทิ้งผลที่ไม่ควรแสดงตามลำดับ: ผู้ใช้ขยับเคอร์เซอร์หรือแก้ไฟล์ไปแล้ว ผลว่าง บรรทัดแรกซ้ำข้อความหลังเคอร์เซอร์
        หรือยาวเกิน 8 บรรทัด ผลที่ผ่านมาถึงตัวกรองถูกบันทึกลง log ของ Tab พร้อมผลว่าแสดงหรือถูกกรอง
        (คำขอที่ถูกยกเลิกบันทึกเป็น `cancelled` คำขอที่ล้มเหลว และผลที่ตรงกับข้อความที่แสดงอยู่แล้ว ไม่ถูกบันทึก)
      ref: packages/core/src/tab/filters.ts#firstFilter
      fork:
        ask: ผลผ่านตัวกรองหรือไม่
        options:
          - id: shown
            label: ผ่าน
            steps:
              - lane: editor
                beat:
                  title: VS Code แสดงข้อความจาง
                  text: ข้อความจางต่อจากเคอร์เซอร์ คุณรับด้วย Tab หรือพิมพ์ต่อก็ได้
                  from: panel
                  to: you
                  sees: "ข้อความจางต่อจากเคอร์เซอร์ `date: Date): boolean {` และบรรทัดถัดไปของฟังก์ชัน"
                  ask: กด Tab ไหม
                at: vscode-ui
                do: >-
                  `TabProvider` คืน inline completion หนึ่งรายการ และจดไว้ว่ากำลังแสดงอยู่ในไฟล์นี้
                sees: >-
                  ข้อความจางต่อจากเคอร์เซอร์ `date: Date): boolean {` และบรรทัดถัดไปของฟังก์ชัน
                ref: "packages/extension/src/tab/tracker.ts#\"shown(uri: vscode.Uri, id: CompletionId, shown: ShownCompletion): void {\""
              - lane: user
                do: ผู้ใช้ตัดสินใจ
                fork:
                  ask: ผู้ใช้กด Tab หรือพิมพ์ต่อ
                  options:
                    - id: accept
                      label: กด Tab
                      steps:
                        - lane: editor
                          beat:
                            title: คุณกด Tab
                            text: VS Code แทรกข้อความ ส่วนขยายจดว่าคุณรับ และตรวจภายหลังว่าข้อความยังอยู่ในไฟล์ไหม
                            from: you
                            to: panel
                            end: โค้ดอยู่ในไฟล์แล้ว
                          at: vscode-ui
                          do: >-
                            VS Code แทรกข้อความแล้วรันคำสั่ง `gcode.tab.accepted` `OutcomeTracker.accepted` บันทึกว่ารับ
                            และตรวจอีกครั้งในภายหลังว่าข้อความยังอยู่ในไฟล์หรือไม่
                          sees: ข้อความที่เคยจางกลายเป็นโค้ดจริงในไฟล์
                          ref: packages/extension/src/tab/tracker.ts#OutcomeTracker.accepted
                          end: { turn: none }
                    - id: ignore
                      label: พิมพ์ต่อ
                      steps:
                        - lane: editor
                          beat:
                            title: คุณพิมพ์ต่อ
                            text: ข้อความจางหายไป ถ้าสิ่งที่คุณพิมพ์ตรงกับต้นของผล ผลนั้นยังใช้ต่อได้
                            from: you
                            to: panel
                            end: ข้อความจางหายไป
                          at: vscode-ui
                          do: >-
                            ข้อความจางหายไป ผลที่ขอไว้แล้วยังใช้ต่อได้ถ้าสิ่งที่ผู้ใช้พิมพ์ตรงกับต้นของมัน
                            เมื่อผลใหม่แสดงในไฟล์เดียวกัน ผลเก่าถูกบันทึกว่าไม่รับ
                          ref: "packages/extension/src/tab/tracker.ts#\"if (previous !== undefined && previous.id !== id) this.#settle(previous.id, { kind: 'rejected' });\""
                          end: { turn: none }
          - id: suppressed
            label: ถูกกรอง
            steps:
              - lane: editor
                beat:
                  title: ไม่มีข้อความจาง
                  text: ส่วนขยายไม่คืนอะไร ผลยังอยู่ใน cache ถ้าคุณพิมพ์ต่อในทางเดียวกับมัน
                  from: panel
                  to: panel
                  end: ไม่มีคำเติม
                at: vscode-ui
                do: >-
                  `TabProvider` ไม่คืนอะไร ไม่มีข้อความจาง ผลยังอยู่ใน cache ถ้าผู้ใช้พิมพ์ต่อในทางเดียวกับมัน
                ref: packages/extension/src/tab/provider.ts#TabProvider.provideInlineCompletionItems
                end: { turn: none }
---

Tab อยู่ใน extension host ทั้งหมด ไม่ใช้ engine ไม่ใช้ ACP และไม่ใช้ model ของแชต
มันคุยกับ llama-server บนเครื่องผ่าน HTTP ซึ่งส่วนขยายเปิดเองถ้า endpoint เป็นเครื่องนี้และยังไม่มีใครตอบ `/health`

| แถบสถานะ | ความหมาย |
| --- | --- |
| Tab ไอคอนวงกลมขีด | ปิดอยู่ คลิกเพื่อเปิด |
| Tab ไอคอนหมุน | กำลังเปิด llama-server |
| Tab ไอคอน sparkle | พร้อม |
| Tab ไอคอนเตือน | เปิดไม่สำเร็จ ชี้เพื่อดูเหตุผล |

สิ่งที่ควรสังเกต

- **ไม่มีอะไรออกนอกเครื่องโดยค่าตั้งต้น** endpoint ตั้งต้นอยู่ที่ `127.0.0.1` prompt ที่มีโค้ดของไฟล์ที่เปิดอยู่ไปถึงแค่ llama-server
- **ผลเดียวใช้ได้หลายครั้ง** ผลที่ขอไปแล้ว ทั้งที่จบแล้วและที่ยัง stream อยู่ ใช้ต่อได้ตราบที่สิ่งที่ผู้ใช้พิมพ์ตรงกับต้นของผลนั้น
  การพิมพ์ตามคำแนะนำจึงไม่ส่งคำขอใหม่ทุกตัวอักษร
- **next edit เป็นอีกทาง** บน VS Code ที่รองรับ inline edits และเปิด `gcode.tab.nextEdit` ส่วนขยายส่งไปที่ตัวแนะนำการแก้ครั้งถัดไปแทน
