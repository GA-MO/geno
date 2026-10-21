---
title: "Context เกินหน้าต่าง Geno ทำ compaction แล้วส่งใหม่"
description: ผู้ให้บริการบอกว่า context เกินหน้าต่าง ด้วย error หรือด้วย stop reason loop สรุปบริบทหนึ่งครั้งแล้วส่งคำขอเดิมใหม่หนึ่งครั้ง ถ้ายังเกินอีก turn จบแบบ failed
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code มี turn ทำงานอยู่
    - ผลของ tool ชุดล่าสุดใหญ่มาก หรือ Geno ไม่รู้ขนาดหน้าต่างของรุ่นที่ใช้ จน context เกินหน้าต่างของ model ก่อนที่การสรุปอัตโนมัติจะได้ทำ
  trigger: >-
    loop ส่งคำขอ model และผู้ให้บริการตอบว่าคำขอยาวเกินไป
  covers: [ctx.overflow-compact-resend]
  related: [ctx.compaction-auto, err.transient-retried, ctx.large-output-spill]
  steps:
    - use: model-call
      beat:
        title: "Geno ส่งคำขอให้ model"
        text: >-
          context คือทุกอย่างที่ Geno ส่งในคำขอ หน้าต่างของ model (context window) คือจำนวน token สูงสุดที่ model อ่านได้ในคำขอเดียว
          ปกติ Geno สรุปส่วนเก่าของบทสนทนาเองก่อนถึงหน้าต่าง เรียกว่า compaction
          แต่ context ยังเกินหน้าต่างได้สองแบบ แบบแรก ผลของ tool ชุดล่าสุดใหญ่มาก (หลายผลรวมกัน หรือมีรูปภาพ) จนเกินก่อน compaction อัตโนมัติจะทันทำ
          แบบที่สอง Geno ไม่รู้ขนาดหน้าต่างของรุ่นนั้น จึงไม่สรุปล่วงหน้าเลย
          การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน แบบที่สอง บน `claude-haiku-4-5-20251001` ชื่อรุ่นแบบมีวันที่ของ Haiku 4.5 (หน้าต่าง 200,000 token)
          Geno ไม่มีข้อมูลของชื่อนี้ จึงขอ `max_tokens` (เพดานความยาวคำตอบ) เต็ม 64,000 ทุกครั้ง มีแต่ผู้ให้บริการที่เห็นว่าหน้าต่างเต็ม
          บนชื่อที่ Geno รู้จัก เช่น `claude-haiku-4-5` แบบไม่มีวันที่ Geno รู้ว่าหน้าต่างมี 200,000 token จึงสรุปเองก่อนที่ 80% และลด `max_tokens` ให้เหลือเท่าที่หน้าต่างยังว่าง
          คำตอบจึงแทบไม่วิ่งชนหน้าต่างระหว่างทางแบบในการ์ด ทางนี้เกิดกับชื่อที่ไม่มีในตารางของ Geno เป็นหลัก การบันทึกจึงใช้ชื่อแบบมีวันที่เพื่อให้ถึงทางนี้
          การ์ดคือข้อความสุดท้ายของคำขอ ผลของ `read` ที่เพิ่งได้ ในการบันทึกนี้ไฟล์จริงเล็ก model จำลองนับ input ของแต่ละคำขอจากความยาวข้อความจริง (ราว 4 ตัวอักษรต่อ token)
          บวกอีก 190,600 token คงที่ทุกคำขอ แทนเนื้อหาก้อนใหญ่ที่ไม่ได้ใส่ในบันทึก ตัวเลขจึงโตตามสิ่งที่เพิ่มในแต่ละคำขอ และคำขอนี้นับได้ 199,596 token
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/ctx-overflow-compact-resend.jsonl#line=12
          select: messages[10].content[0]
          highlight: [content]

    - id: refused
      lane: model
      beat:
        title: "ผู้ให้บริการบอกว่า context เต็มหน้าต่าง"
        text: >-
          ผู้ให้บริการบอกเรื่องนี้ได้สองแบบ แบบแรกคือตอบ error ทันทีโดยไม่เริ่มคำตอบ เช่น Anthropic ตอบ 400 ข้อความ "prompt is too long"
          Geno รู้จักถ้อยคำอื่นด้วย เช่น `request_too_large` (มากับสถานะ 413) หรือ "maximum context length is N tokens" ของผู้ให้บริการแบบ OpenAI
          แบบที่สองคือ model เริ่มเขียนคำตอบแล้ว แต่คำขอรวมกับที่เขียนไปเต็มหน้าต่างระหว่างทาง คำตอบจึงหยุดด้วย `stop_reason` (field ท้ายคำตอบที่บอกว่าทำไมหยุด)
          เป็น `model_context_window_exceeded` ค่านี้มาได้เฉพาะผู้ให้บริการที่ Geno คุยด้วยรูปแบบ Anthropic Messages คือ `anthropic`, `bedrock`, `vertex`, `openrouter` และ `modelstudio`
          ผู้ให้บริการแบบ OpenAI ไม่ส่งค่านี้ ถ้า context ล้นก็บอกด้วยข้อความ error อย่างเดียว
          การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน และเป็นแบบที่สอง แท็บแรกคือ event แรกของ stream ดู `input_tokens` ที่ไฮไลต์ คำขอนับได้ 199,596 token
          event ระหว่างกลางที่การ์ดไม่ได้แสดงคือข้อความที่ model เขียนได้ครึ่งทาง แท็บสองคือ event ท้าย stream ดู `stop_reason` ที่ไฮไลต์
          และ `output_tokens` 404 ซึ่งรวมกับ input ได้ 200,000 พอดีหน้าต่าง
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/ctx-overflow-compact-resend.jsonl#line=13
            select: '[0]'
            highlight: [data.message.usage.input_tokens]
          - kind: payload
            source: packages/docs/src/data/recorded/ctx-overflow-compact-resend.jsonl#line=13
            select: '[-2]'
            highlight: [data.delta.stop_reason, data.usage.output_tokens]
      do: >-
        ผู้ให้บริการตอบ error ที่ข้อความบอกว่ายาวเกิน (Anthropic ตอบ 400 "prompt is too long") หรือบนผู้ให้บริการแบบ Anthropic Messages
        คำตอบที่กำลังเขียนหยุดด้วย `stop_reason: model_context_window_exceeded` เมื่อ context เต็มหน้าต่างระหว่างทาง
      ref: packages/engine/src/wire.ts#anthropicWire
      emits: [model_context_window_exceeded]

    - id: kind
      lane: loop
      at: gateway
      beat:
        title: "Geno รู้ว่าเป็น overflow ไม่ retry"
        text: >-
          ทางที่การ์ดแสดงไม่มี error ให้อ่าน `stop_reason` ค่านี้อย่างเดียวก็พอให้ Geno จัดเป็น overflow (context ล้น)
          ข้อความที่ model เขียนมาครึ่งทางขึ้นในแชตไปแล้วระหว่าง stream และแผงแชตไม่ลบมันออก มันค้างอยู่เหนือสิ่งที่ตามมา
          แต่ Geno ไม่เก็บข้อความนั้นลง log และไม่ใส่ในคำขอถัดไป ถ้าเปิด session นี้ใหม่ แชตสร้างจาก log ข้อความครึ่งทางจึงหายไป
          Geno ใช้ข้อความ error ของตัวเองว่า "the conversation filled the model’s context window"
          ทาง error สถานะอย่าง 400 ปกติแปลว่าคำขอผิดและแก้ไม่ได้ Geno จึงอ่านข้อความของ error ก่อนดูสถานะ
          ถ้าข้อความตรงกับถ้อยคำเรื่อง context ยาวเกินที่ Geno รู้จัก ซึ่งครอบคลุมถ้อยคำของผู้ให้บริการหลายราย ก็เป็น overflow ไม่ว่าสถานะจะเป็นอะไร
          overflow แก้ได้ด้วยการย่อ ไม่ใช่ error ที่ต้องหยุด แต่การส่งคำขอเดิมซ้ำ (retry) ไม่ช่วย Geno จึงไม่ retry และส่งเรื่องให้ loop จัดการเอง
        from: engine
        to: engine
      do: >-
        ทาง stop reason `gateway.call` เห็น `model_context_window_exceeded` แล้วคืน error ชนิด `overflow` ทันทีโดยไม่เก็บ content ที่ stream มา
        ทาง error `classifyFailure` เทียบข้อความกับรายการ `OVERFLOW` ก่อนดูสถานะ (หลังเช็กข้อความเรื่องโควตาและ rate limit) ข้อความเรื่อง context ยาวเกินจึงได้ `overflow` ไม่ใช่ `fatal`
        ทั้งสองทาง gateway ไม่ลองซ้ำ แต่คืนผลเป็น error ชนิด `overflow` เพื่อให้ loop จัดการเอง
      ref: packages/core/src/model-error.ts#TURN_ERROR_OF
      emits: [overflow]

    - id: compact
      lane: loop
      at: model-call
      beat:
        title: "Geno ทำ compaction ทันที"
        text: >-
          Geno ยังไม่บันทึก error แต่เริ่ม compaction ทันที ปกติก่อนสรุปเอง Geno ประเมินว่าสรุปแล้ว context จะต่ำกว่าเกณฑ์ หรือลดได้อย่างน้อยครึ่งไหม
          ทางนี้ข้ามการประเมินนั้น เพราะส่งแบบเดิมไม่ได้อยู่แล้ว
        from: engine
        to: engine
      do: >-
        `callModel` เห็น error ชนิด `overflow` จึงเรียก `compact('overflow')` ทันที ยังไม่บันทึก error ลง log
        การสรุปแบบนี้ไม่ตรวจว่าจะต่ำกว่าเกณฑ์หรือลดได้ครึ่งหนึ่งไหม เพราะส่งแบบเดิมไม่ได้อยู่แล้ว
      ref: "packages/engine/src/drive.ts#\"if (result.kind === 'error' && result.error === 'overflow' && (await compact('overflow'))) result = await send();\""

    - use: ctx-compacts
      beat:
        title: "Model สรุป แล้วแชตขึ้นเส้นคั่น"
        text: >-
          แชตขึ้นแถว Compacting the context ส่วนเก่าถูกส่งให้ model สรุป ช่วงท้ายล่าสุดเก็บไว้ตามเดิม
          แล้วแชตขึ้นเส้นคั่นที่เปิดดูสรุปได้ ไม่มีบันทึกจาก model จริงของทางที่ context เกินหน้าต่าง การ์ดที่สองจึงเป็นสรุปจริงจากการรันใน terminal ที่ตั้ง `GCODE_COMPACT_AT` ต่ำ
          Geno จึงสรุปเองก่อนเรียก สรุปของทางนี้มีรูปเดียวกัน ดู field `summary` ที่ไฮไลต์ในการ์ดนั้น
        from: model
        to: engine
        sees:
          - { kind: notice, text: Compacting the context, tone: info }
          - kind: payload
            source: docs/results/real-usecases/runs/A16-compaction-goal/2/session.jsonl.gz#seq=59
            highlight: [summary]

    - id: resend
      lane: loop
      at: gateway
      beat:
        title: "Geno ส่งคำขอเดิมที่เล็กลงอีกครั้ง"
        text: >-
          Geno ส่งคำขอเดิมด้วย context ที่เล็กลง ใช้ checkpoint (ภาพถ่ายไฟล์ที่เก็บก่อนเรียก model) อันเดิม
          นี่คือการส่งซ้ำครั้งเดียวที่ Geno ให้ ข้อความแรกของคำขอมีสรุปแทนส่วนเก่า ตามด้วยช่วงท้ายที่เก็บไว้
          การ์ดข้างล่างเป็นคำขอจริงหลังสรุปจากการรันเดียวกับการ์ดสรุป (ที่ตั้งเกณฑ์ต่ำ) ซึ่งไม่ได้ถูกปฏิเสธก่อน แต่คำขอหลังสรุปมีรูปเดียวกัน
          บล็อกที่ไฮไลต์ขึ้นต้นด้วย `<compacted_context>` คือสรุป
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A16-compaction-goal/2/requests.jsonl.gz#seq=62
          select: messages
          collapse: ['[1]', '[2]']
          highlight: ['[0].content[2]']
        ask: "รับคำขอไหม"
      do: >-
        `send()` ส่งคำขออีกครั้งด้วย `contextView` ที่เล็กลง ใช้ checkpoint เดิม ไม่บันทึกใหม่
        นี่คือการส่งซ้ำครั้งเดียวที่ loop ให้
      ref: packages/engine/src/drive.ts#callModel
      phase: calling-model
      fork:
        ask: ผู้ให้บริการรับคำขอที่เล็กลงไหม
        options:
          - id: accepted
            label: รับ
            steps:
              - lane: model
                beat:
                  title: "ผู้ให้บริการรับ คำตอบขึ้นในแชต"
                  text: >-
                    ผู้ให้บริการตอบตามปกติ คำตอบ stream ออกมาทีละส่วน การ์ดแรกคือข้อความที่ขึ้นในแชต การ์ดที่สองเป็นคำตอบจริงต่อคำขอในการ์ดก่อน
                    ข้อความที่ไฮไลต์แสดงว่า model ทำงานต่อจากสรุปได้ มันรู้ว่าเหลือไฟล์ไหนต้องแก้
                  from: model
                  to: engine
                  sees:
                    - { kind: message, from: geno, text: "The two remaining single-line comments are in wallet.ts and warehouse.ts (step 3), which I fix now.", streaming: true }
                    - kind: payload
                      source: docs/results/real-usecases/runs/A16-compaction-goal/2/session.jsonl.gz#seq=62
                      select: content
                      collapse: ['[0].thinking']
                      highlight: ['[1].text']
                do: >-
                  ผู้ให้บริการตอบตามปกติ stream คำตอบออกมา
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
              - lane: panel
                at: rail
                beat:
                  title: "เส้นคั่นบอกว่าทำไมสรุป"
                  text: >-
                    คำตอบขึ้นต่อจากเส้นคั่น เปิดเส้นคั่นแล้วเห็นเหตุผลว่า model ปฏิเสธเพราะยาวเกิน Geno จึงสรุปแล้วส่งใหม่
                    ข้อความนี้เหมือนกันทั้งทาง error และทาง `stop_reason` ที่ model เริ่มตอบแล้ว Geno
                    บันทึกคำตอบแล้ว turn ทำต่อตามปกติ
                  from: panel
                  to: you
                  end: "ส่งใหม่สำเร็จ turn ทำต่อ"
                  sees: "เส้นคั่น \"Context compacted\" ที่เปิดแล้วมีเหตุผล \"The model refused the request as too long, so Geno compacted and sent it again.\""
                alongside: true
                do: >-
                  คำตอบขึ้นต่อจากเส้นคั่น ซึ่งบอกเหตุผลว่าทำไมสรุป
                sees: >-
                  เส้นคั่น "Context compacted" ที่เปิดแล้วมีเหตุผล
                  "The model refused the request as too long, so Geno compacted and sent it again."
                ref: packages/extension/src/chat/compact-model.ts#compactLook
              - lane: loop
                at: drive
                do: >-
                  `callModel` บันทึก event `assistant` ของคำตอบ แล้ว `loopStep` ตัดสินขั้นต่อไปตามปกติ
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
                emits: [assistant]
                end: { turn: continues }

          - id: still-too-long
            label: ยังยาวเกิน
            steps:
              - lane: model
                beat:
                  title: "ยังยาวเกิน"
                  text: >-
                    context ยังเกินหน้าต่างอีก เช่นช่วงท้ายที่เก็บไว้มีผลของ tool ก้อนใหญ่ที่สรุปไม่ได้
                    การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ในการบันทึกนี้ส่วนที่ตัดออกมีแค่ prompt แรกกับการอ่าน `src/version.ts`
                    การอ่าน `src/cli.ts` `src/update.ts` และ `package.json` อยู่ในช่วงท้ายที่เก็บไว้
                    ส่วน 190,600 token คงที่ก็ยังอยู่ และบล็อกสรุปยาวกว่าส่วนที่ตัดออก คำขอที่ส่งซ้ำจึงนับได้ 199,745 token มากกว่าเดิมเล็กน้อย
                    คำตอบเขียนได้ 255 token แล้วหยุดแบบเดิม ดู `stop_reason` และ `output_tokens` ที่ไฮไลต์
                    คำตอบครึ่งทางรอบนี้ก็ขึ้นในแชตระหว่าง stream เหมือนรอบแรก แชตจึงมีคำตอบที่ไม่จบสองชิ้น
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/ctx-overflow-compact-resend.jsonl#line=17
                    select: '[-2]'
                    highlight: [data.delta.stop_reason, data.usage.output_tokens]
                do: >-
                  ผู้ให้บริการตอบ error ว่ายาวเกินอีก หรือคำตอบหยุดด้วย `model_context_window_exceeded` อีก เช่นช่วงท้ายที่เก็บไว้มีผล tool ก้อนใหญ่ที่สรุปไม่ได้
                ref: packages/engine/src/wire.ts#anthropicWire
              - lane: loop
                at: gateway
                beat:
                  title: "Geno ไม่สรุปซ้ำและไม่ส่งซ้ำ"
                  text: >-
                    Geno ให้โอกาสส่งซ้ำครั้งเดียว คราวนี้จึงถือว่าการเรียกล้ม
                  from: engine
                  to: engine
                do: >-
                  gateway คืน error ชนิด `overflow` อีกครั้ง loop ไม่สรุปซ้ำและไม่ส่งซ้ำอีก
                ref: packages/core/src/model-error.ts#TURN_ERROR_OF
                emits: [overflow]
              - use: err-turn-fails
                beat:
                  title: "แชตขึ้นแถบ error แล้ว turn ล้มเหลว"
                  text: >-
                    Geno บันทึก error แชตขึ้นแถบสีแดงพร้อมข้อความของ error และ turn จบแบบ failed
                    ทางที่การ์ดแสดง ข้อความคือ "the conversation filled the model’s context window" ของ Geno เอง ส่วนทาง error แถบแสดงข้อความของผู้ให้บริการ เช่น "prompt is too long"
                  from: engine
                  to: panel
                  end: "ยังยาวเกิน turn ล้มเหลว"
                  sees: { kind: notice, text: "the conversation filled the model’s context window", tone: error }
---

เมื่อรู้ขนาดหน้าต่างของรุ่นที่ใช้ Geno พยายามสรุปก่อนถึงขอบหน้าต่างเสมอ ([สรุปบริบทอัตโนมัติ](/scenarios/ctx/compaction-auto/)) ทางนี้จึงเกิดเมื่อการประเมินขนาดพลาด
เช่น token ที่ประเมินจากจำนวนตัวอักษรน้อยกว่าที่ผู้ให้บริการนับจริง หรือผล tool ชุดเดียวใหญ่จนกระโดดข้ามเกณฑ์ไป
ส่วนชื่อรุ่นที่ไม่มีในตารางของ Geno Geno ไม่รู้ขนาดหน้าต่าง จึงไม่สรุปล่วงหน้า เว้นแต่ตั้ง `GCODE_COMPACT_AT` ไว้ ทางนี้จึงเป็นทางเดียวที่ Geno ย่อ context ให้เอง
Geno เทียบชื่อแบบตรงตัว ชื่อแบบมีวันที่ต่อท้ายอย่าง `claude-haiku-4-5-20251001` จึงนับเป็นชื่อที่ไม่มี แม้ `claude-haiku-4-5` จะมีในตาราง

สิ่งที่ควรสังเกต

- **สรุปหนึ่งครั้ง ส่งใหม่หนึ่งครั้ง** ไม่มีวงวน ถ้าคำขอที่สองถูกปฏิเสธ turn จบแบบ failed ด้วย error ชนิด `overflow`
- **ไม่มีจุดตัดก็ไม่มีการส่งซ้ำ** ถ้า `planCompaction` หาจุดตัดไม่ได้ (เช่น turn แรกที่ยังไม่มีคำตอบของ model เลย)
  หรือการเรียกเพื่อสรุปล้ม `compact()` คืน false แล้ว error ชนิด `overflow` ถูกบันทึกทันที
- **prompt ยังค้างอยู่** turn ที่ล้มด้วย `overflow` ไม่ทิ้ง prompt ที่ยังไม่ได้คำตอบ ข้อความถัดไปของผู้ใช้จะส่งไปพร้อม prompt เดิม
  และถ้าผู้ใช้กดปุ่ม Compact หรือพิมพ์ `/compact` ก่อน ([สรุปด้วยมือ](/scenarios/ctx/compaction-manual/)) ข้อความถัดไปก็มีที่พอ

error อื่นของผู้ให้บริการ ดู [ผู้ให้บริการล้มชั่วคราว Geno retry เอง](/scenarios/err/transient-retried/)
