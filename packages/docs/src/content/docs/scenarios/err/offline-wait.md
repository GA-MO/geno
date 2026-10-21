---
title: "เครือข่ายหลุดหรือชน rate limit แล้ว Geno รอ"
description: การเรียก model ไปไม่ถึงผู้ให้บริการหรือได้ 429 turn ไม่ล้ม แต่รอพร้อมปุ่ม Retry now จนเครือข่ายกลับมา ถึงเวลา ผู้ใช้กด หรือหมดเวลารอ
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code มี turn ทำงานอยู่
    - ค่า `gcode.resume.afterLimit` เป็นค่าเริ่มต้น `short`
  trigger: >-
    loop ส่งคำขอ model แต่เครือข่ายหลุด หรือผู้ให้บริการตอบ 429
  covers: [err.offline-wait, err.rate-limited, ctl.stop-while-waiting]
  related: [err.transient-retried, ctl.stop-while-streaming, bg.task-attention]
  steps:
    - use: model-call
      beat:
        title: "Geno ส่งคำขอให้ model"
        text: >-
          turn กำลังทำงาน Geno ส่งคำขอให้ model ตามปกติ การ์ดข้างล่างคือ `messages` ของคำขอจริงไปยัง Anthropic
          จากการรันอื่นที่ไม่มี error ดูสองก้อนที่ไฮไลต์ท้ายสุด: `tool_use` คือคำขอ `read` ของ model รอบก่อน และ `tool_result`
          คือผลที่ Geno ส่งกลับ ถ้าการเรียกนี้ไปไม่ถึง Geno จะส่งบทสนทนาเดิมนี้อีกครั้งเมื่อการรอจบ
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A20-thai-question/sonnet-1/wire.jsonl#line=5
          select: messages
          collapse: ['[0]', '[1]', '[2]']
          highlight: ['[3].content[0]', '[4].content[0]']

    - id: kind
      lane: loop
      at: gateway
      beat:
        title: "การเรียกไม่ได้คำตอบ"
        text: >-
          Geno ส่ง error ให้ตัวแยกชนิด ซึ่งตัดสินว่าจะลองใหม่เร็วๆ รอนาน หรือเลิก ลองเลือกว่าเกิดอะไรขึ้น
        from: engine
        to: engine
        ask: "เกิดอะไรขึ้น"
      do: >-
        การเรียกไม่ได้คำตอบ `gatewayFor.turn` ส่ง error ให้ `classifyFailure` แยกชนิด
      ref: packages/engine/src/gateway.ts#gatewayFor.turn
      fork:
        ask: เกิดอะไรขึ้นกับการเรียก
        options:
          - id: offline
            label: เครือข่ายหลุด
            then: logged
            steps:
              - lane: external
                beat:
                  title: "เครือข่ายหลุดก่อนได้ byte แรก"
                  text: >-
                    การเชื่อมต่อไปหาผู้ให้บริการล้ม ไม่มีสถานะ HTTP กลับมา Geno จึงถือว่าออฟไลน์ และวางแผนรอ 5
                    วินาทีแล้วตรวจเครือข่าย เวลารอเพิ่มเป็นสองเท่าจนถึง 60 วินาที และเลิกเมื่อครบ 30 นาที
                  from: engine
                  to: engine
                do: >-
                  การเชื่อมต่อไปหาผู้ให้บริการล้มก่อนได้ byte แรก เช่น `ECONNREFUSED` หรือหา DNS ไม่เจอ
                  ไม่มีสถานะ HTTP กลับมา
              - lane: loop
                at: gateway
                do: >-
                  ไม่มีสถานะ ไม่มีอะไร stream มา และข้อความตรงรูปแบบการเชื่อมต่อล้ม `classifyFailure` จึงได้ `offline`
                  `planWait` ให้รอ 5 วินาทีแล้วค่อยตรวจเครือข่าย เวลารอเพิ่มเป็นสองเท่าจนถึง 60 วินาที และเลิกเมื่อครบ 30 นาที
                ref: packages/core/src/waiting.ts#planWait
                emits: [offline]

          - id: limited
            label: 429 rate limit
            then: logged
            steps:
              - lane: model
                beat:
                  title: "ผู้ให้บริการตอบ 429"
                  text: >-
                    คุณชน rate limit คือเพดานจำนวนคำขอหรือ token ต่อช่วงเวลาที่ผู้ให้บริการตั้งไว้ ผู้ให้บริการบางรายบอกเวลาที่ขีดจำกัด
                    จะรีเซ็ตมาด้วย Geno รอถึงเวลานั้น ถ้าไม่รู้เวลา รอ 15 วินาทีแล้วเพิ่มขึ้น การรอสั้นๆ พักการเรียกของทุก session
                    ใน engine นี้ด้วย
                    การ์ดข้างล่างเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน บน `claude-sonnet-5-5` ผ่าน API ของ Anthropic
                    model จำลองตอบคำขอที่สองด้วย HTTP 429 ในรูปแบบ error ของ Anthropic และการบันทึกเลือกส่ง header ชุดนี้ ดูจุดที่ไฮไลต์: `status` คือ 429
                    `body.error.type` คือ `rate_limit_error` และ header `retry-after` คือ 3 แปลว่าให้ลองใหม่ในอีก 3 วินาที
                    Geno อ่าน `retry-after-ms` ก่อน แล้วจึง `retry-after` ทั้งสองมาก่อน header ของ bucket อย่าง `anthropic-ratelimit-requests-reset`
                    ในการบันทึกนี้ไม่มี `retry-after-ms` จึงใช้ `retry-after` header `anthropic-ratelimit-requests-remaining` ที่เป็น 0 บอกว่าโควตาคำขอของนาทีนี้หมดแล้ว
                    ถ้า 429 ไม่บอกเวลารีเซ็ตเลย Geno ใช้การรอแบบไม่รู้เวลาที่กล่าวไว้ข้างบน
                    ในการบันทึกนี้ Geno รอ 3 วินาทีตาม `retry-after` บวกสุ่มไม่เกิน 3 วินาที
                    แล้วส่งบทสนทนาเดิมซ้ำ และได้คำตอบ
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/err-rate-limited-waits.jsonl#line=5
                    highlight: [status, body.error.type, headers.retry-after, headers.anthropic-ratelimit-requests-remaining]
                do: >-
                  ผู้ให้บริการตอบ 429 บางรายบอกเวลาที่ขีดจำกัดจะรีเซ็ตไว้ใน header เช่น `retry-after`
                  หรือ `anthropic-ratelimit-requests-reset`
                ref: packages/engine/src/wire.ts#anthropicWire
              - lane: loop
                at: gateway
                do: >-
                  `classifyFailure` ได้ `limited` และ `resetAtOf` อ่านเวลารีเซ็ตจาก header หรือ body
                  `planWait` ให้รอถึงเวลารีเซ็ตบวกสุ่มไม่เกิน 3 วินาที ถ้าไม่รู้เวลา ให้รอ 15 วินาที เพิ่มขึ้นจนถึง 5 นาที
                  และเลิกเมื่อครบ 15 นาที ถ้าการรอไม่เกิน 20 วินาที `slots.pause` หยุดการเรียกที่ยังไม่เริ่มของทุก session
                  ใน engine นี้ด้วย
                ref: packages/core/src/model-error.ts#resetAtOf
                emits: [limited]

    - id: logged
      lane: loop
      at: model-call
      beat:
        title: "Geno บันทึกว่ากำลังรอ"
        text: >-
          Geno บันทึกการรอลงบันทึกของ session ถ้า engine ตายระหว่างนี้ ตัวใหม่จะเห็นแล้วรอต่อ งานในแผง Tasks
          (แผงที่แสดงงานที่กำลังรันของทุกแชต) เปลี่ยนเป็น waiting และแชตได้รับแจ้ง
        from: engine
        to: panel
      do: >-
        `onWait` บันทึก event `wait` ลง log เมื่อการรอเริ่มหรือเปลี่ยนทาง engine ที่เปิดใหม่หลังจากนี้จะเห็น event นี้แล้วรอต่อ
        จากนั้นบอก watcher
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'wait', seq: nextSeq(events)\""
      emits: [wait]
      phase: waiting-retry

    - id: task
      lane: server
      at: tasks
      do: >-
        `Tasks.wait` เปลี่ยนสถานะงานของ session นี้ในแผง Tasks เป็น `waiting` พร้อมข้อความการรอ
      ref: packages/engine/src/tasks.ts#Tasks.wait
      emits: [waiting]

    - id: notice
      lane: server
      at: updates
      do: >-
        `waitUpdate` ส่ง `session/update` ชนิด `notice` ระดับ warning หัวข้อจาก `waitLabel`
        และสถานะการรอทั้งก้อนใน `_meta` ใต้ `WAITING_META`
      ref: packages/engine/src/wait-hooks.ts#waitUpdate
      emits: [notice, gcode/waiting]

    - id: relay
      lane: editor
      at: chat
      alongside: true
      do: >-
        `UPDATES.notice` เห็น `WAITING_META` จึงส่ง action `waiting` ให้ webview
      ref: packages/extension/src/chat/session-updates.ts#UPDATES.notice
      emits: [waiting]

    - id: header
      lane: panel
      at: rail
      beat:
        title: "แชตบอกว่ากำลังรอ พร้อมปุ่ม Retry now"
        text: >-
          หัวข้อของ turn เปลี่ยนจาก working เป็นการรอ แถวเหนือช่องพิมพ์บอกว่ารอถึงเมื่อไร และมีปุ่มให้ลองทันที turn
          ยังไม่ล้ม การ์ดเป็นทางออฟไลน์ ทาง 429 หัวข้อเป็น `waiting for the rate limit` และแถวบอก `Limited until <เวลา>`
          หรือ `Limited, retrying in …`
        from: panel
        to: you
        sees:
          - kind: composer
            state: working
            header: waiting for the network
          - kind: notice
            text: Offline, retrying in 5s
            actions:
              - Retry now
            tone: warning
      alongside: true
      do: >-
        `headerOf` เปลี่ยนหัวข้อของ turn ตามชนิดการรอ
      sees: หัวข้อ "waiting for the network" หรือ "waiting for the rate limit" แทน "working"
      ref: packages/extension/src/chat/rail.ts#WAIT_HEADERS

    - id: row
      lane: panel
      at: composer
      do: >-
        แถวสถานะเหนือช่องพิมพ์เปลี่ยนจากเวลาที่ทำงานเป็นข้อความการรอกับปุ่ม Retry now
      sees: >-
        "Offline, retrying in 5s [Retry now]" หรือ "Limited until 14:05 [Retry now]"
      ref: "packages/extension/src/chat/composer-view.ts#\"const wait = h('span', { class: 'run-wait', hidden: true }\""

    - id: hold
      lane: loop
      at: gateway
      beat:
        title: "Geno นอนรอถึงเวลาลองครั้งถัดไป"
        text: >-
          เมื่อออฟไลน์ Geno ตื่นแล้วตรวจ host ก่อน ถ้ายังไม่ตอบก็รอรอบใหม่นานขึ้น เมื่อถูกจำกัด Geno ตื่นแล้วเรียกเลย
          ถ้าเวลารีเซ็ตไกลกว่า 15 นาที Geno ไม่ปลุกเอง และรอคุณ กฎนี้ต่างจากการเลิกรอ 15 นาทีเมื่อไม่รู้เวลารีเซ็ต
        from: engine
        to: engine
        ask: "อะไรมาก่อน"
      do: >-
        `holdOn` นอนรอถึงเวลาลองครั้งถัดไป เมื่อออฟไลน์ ตื่นแล้วตรวจ host ก่อน ถ้ายังไม่ตอบก็รอรอบใหม่นานขึ้น
        เมื่อถูกจำกัด ตื่นแล้วเรียกเลย ถ้าเวลารีเซ็ตไกลกว่า 15 นาที การรอไม่มีเวลาปลุก (`hold`) และรอจนผู้ใช้กด Retry now หรือ Stop
      ref: "packages/engine/src/gateway.ts#\"const holdOn = async (): Promise<Held> => {\""
      fork:
        ask: อะไรมาก่อน
        options:
          - id: back
            label: เครือข่ายกลับมา หรือถึงเวลารีเซ็ต
            then: goes
            steps:
              - lane: loop
                at: gateway
                beat:
                  title: "เครือข่ายกลับมา หรือถึงเวลารีเซ็ต"
                  text: >-
                    Geno ตื่นตามเวลา เมื่อออฟไลน์ host ตอบแล้ว เมื่อถูกจำกัด ถึงเวลารีเซ็ตที่ผู้ให้บริการบอก หรือครบเวลารอของ Geno เองเมื่อไม่รู้เวลารีเซ็ต การเรียกจึงออกไปได้
                  from: engine
                  to: engine
                do: >-
                  `nap` ตื่นตามเวลา เมื่อออฟไลน์ `wire.probe` ตรวจ host แล้วพบว่าตอบ เมื่อถูกจำกัด ถึงเวลารีเซ็ตที่ผู้ให้บริการบอก หรือครบเวลา backoff ที่ `planWait` คำนวณเมื่อไม่รู้เวลารีเซ็ต
                  การเรียกจึงออกไปได้
                ref: packages/engine/src/waits.ts#nap

          - id: retry-now
            label: ผู้ใช้กด Retry now
            then: goes
            steps:
              - lane: user
                beat:
                  title: "คุณกด Retry now"
                  text: >-
                    คุณไม่อยากรอ VS Code ขอ engine ให้ปลุก turn นี้ Geno เรียกทันทีโดยไม่ตรวจ host ถ้ายังออฟไลน์หรือยังถูกจำกัด การรอเดิมทำต่อ
                    และเวลาเลิกยังนับจากตอนเริ่มรอครั้งแรก
                  from: you
                  to: panel
                do: ผู้ใช้ไม่อยากรอ จึงกด Retry now
              - lane: panel
                at: composer
                do: >-
                  ปุ่มโพสต์ข้อความ `retry-now` ไปให้ extension host
                ref: "packages/extension/src/chat/composer-view.ts#\"onclick: () => post({ type: 'retry-now' })\""
                emits: [retry-now]
              - lane: editor
                at: chat
                do: >-
                  `Chat.retryNow` ส่งคำขอ ACP `_gcode/retryNow` ของ session ที่มี turn ทำงานอยู่
                ref: packages/extension/src/chat/chat.ts#Chat.retryNow
                emits: [_gcode/retryNow]
              - lane: server
                at: turns
                do: >-
                  engine หา `Wake` ของ session ใน `retries` แล้วปลุก ตอบกลับ `retried: true`
                ref: "packages/engine/src/serve.ts#\".onRequest(RETRY_NOW_METHOD\""
              - lane: loop
                at: gateway
                do: >-
                  `nap` ได้ผล `woken` จึงเรียกทันทีโดยไม่ตรวจ host ก่อน ถ้ายังออฟไลน์หรือยังถูกจำกัด การรอเดิมทำต่อ เวลาเลิกยังนับจากตอนเริ่มรอครั้งแรก
                ref: packages/engine/src/waits.ts#nap

          - id: stop
            label: ผู้ใช้กด Stop
            steps:
              - lane: user
                beat:
                  title: "คุณกด Stop ระหว่างรอ"
                  text: >-
                    คุณเลิกรอ ถ้ามีการ์ดขอสิทธิ์ค้างอยู่ แผงตอบการ์ดนั้นว่ายกเลิก แล้วสั่ง Geno หยุด turn การ์ดเป็นทางออฟไลน์
                    ทาง 429 หัวข้อเป็น `waiting for the rate limit`
                  from: you
                  to: panel
                  sees: { kind: composer, state: working, header: waiting for the network }
                do: ผู้ใช้กด Stop ระหว่างรอ
              - lane: editor
                at: chat
                do: >-
                  `Chat.stop` ตอบการ์ดที่เปิดอยู่ว่ายกเลิก แล้วส่ง notification ACP `session/cancel`
                ref: packages/extension/src/chat/chat.ts#Chat.stop
                emits: [session/cancel]
              - lane: server
                at: turns
                beat:
                  title: "Geno ยกเลิก turn"
                  text: >-
                    engine ยกเลิก turn การรอจบทันที Geno บันทึกว่าคุณเป็นคนหยุด แล้วจบ turn แบบ stopped
                  from: engine
                  to: engine
                do: >-
                  engine หา `AbortController` ของ turn ใน `turns` แล้ว abort
                ref: "packages/engine/src/serve.ts#\"turns.get(params.sessionId)?.abort();\""
              - lane: loop
                at: gateway
                do: >-
                  `nap` ได้ผล `aborted` gateway ปิดการรอแล้วคืน `ABORTED` `callModel` บันทึก event `error` ชนิด `abort`
                  และ `loopStep` ตัดสิน `done(error)`
                ref: packages/engine/src/gateway.ts#ABORTED
                emits: [abort]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `runTurn` เห็นว่า signal ถูก abort จึงใช้ `TURN_ENDS.cancelled`: ACP ได้ `stopReason: cancelled`
                  งานในแผง Tasks จบแบบ stopped
                ref: "packages/engine/src/serve.ts#\"const end: TurnEnd = controller.signal.aborted ? 'cancelled' : ran.reason;\""
                emits: [cancelled]
              - lane: editor
                at: chat
                do: >-
                  `prompt()` ใช้ `turnEndOf` อ่านได้ `stopped` และส่ง action `turn-end` (error ชนิด `abort` ไม่ขึ้นเป็นแถบ error)
                ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
                emits: [turn-end]
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นว่าคุณเป็นคนหยุด"
                  text: >-
                    turn ไม่มีข้อความตอบและไม่มีแถบ error แผงจึงขึ้นประกาศพร้อมปุ่มให้ทำต่อ
                  from: panel
                  to: you
                  end: "คุณหยุด turn"
                  sees: { kind: notice, text: Geno stopped without a reply, detail: You stopped it before it answered., actions: [ Continue, Retry ], tone: warning }
                do: >-
                  turn ไม่มีข้อความตอบและไม่มีแถบ error `missingReply` จึงแสดงประกาศพร้อมปุ่มให้ทำต่อ
                sees: >-
                  หัวข้อ "stopped after 1m 12s" และประกาศ "Geno stopped without a reply · You stopped it before it answered." [Continue] [Retry]
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: stopped, reason: cancelled }

          - id: give-up
            label: รอจนหมดเวลา
            steps:
              - lane: loop
                at: gateway
                beat:
                  title: "รอจนหมดเวลา Geno เลิก"
                  text: >-
                    ออฟไลน์ครบ 30 นาที หรือถูกจำกัดโดยไม่รู้เวลารีเซ็ตครบ 15 นาที Geno ปิดการรอ แล้วถือว่าการเรียกนี้ล้ม
                    พร้อมเหตุผลของการเลิก
                  from: engine
                  to: engine
                do: >-
                  `planWait` ได้ `give-up`: ออฟไลน์ครบ 30 นาที หรือถูกจำกัดโดยไม่รู้เวลารีเซ็ตครบ 15 นาที
                  gateway ปิดการรอและคืน error ชนิด `transport` ข้อความต่อท้ายด้วยเหตุผลของการเลิก เช่นเมื่อออฟไลน์
                  "the provider has not answered for 30 minutes; check the connection and send again"
                ref: packages/core/src/waiting.ts#planWait
                emits: [give-up, transport]
              - use: err-turn-fails
                beat:
                  title: "แชตขึ้นแถบ error แล้ว turn ล้มเหลว"
                  text: >-
                    Geno บันทึก error แชตขึ้นแถบสีแดงพร้อมเหตุผล และ turn จบแบบ failed prompt
                    ที่ยังไม่ได้คำตอบไปกับข้อความถัดไปที่คุณส่ง การ์ดเป็นทางออฟไลน์ ทาง 429 ข้อความคือ
                    `the provider kept refusing the call for 15 minutes without saying when its limit resets; send again later`
                  from: engine
                  to: panel
                  end: "หมดเวลารอ turn ล้มเหลว"
                  sees: { kind: notice, text: the provider has not answered for 30 minutes; check the connection and send again, tone: error }

    - id: goes
      lane: loop
      at: gateway
      do: >-
        การเรียกออกไปอีกครั้ง แต่การรอยังไม่ถูกปิดตอนนี้ `endWait` บอก watcher ว่าไม่รอแล้ว (`onWait(null)`)
        เมื่อ `slots.run` ของการเรียกนี้คืนผล คือหลังคำตอบ stream จบ หรือเมื่อการเรียกล้มอีกครั้ง
      ref: "packages/engine/src/gateway.ts#\"const endWait = async () => {\""
      phase: calling-model

    - id: cleared
      lane: server
      at: updates
      do: >-
        เมื่อการเรียกจบ `waitUpdate(null)` ส่ง `notice` "Sending again" พร้อม `WAITING_META` เป็น null และงานในแผง Tasks กลับเป็น running
        ระหว่างที่คำตอบ stream ก่อนหน้านั้น turn ในแผงยังถือ `waiting` อยู่
      ref: packages/engine/src/wait-hooks.ts#waitUpdate
      emits: [Sending again]

    - id: working
      lane: panel
      at: rail
      beat:
        title: "แชตกลับมาเป็น working"
        text: >-
          เมื่อการเรียกที่ออกไปใหม่ได้ผล Geno ปิดการรอ แถวการรอหายไป เวลาที่ทำงานกลับมา และหัวข้อกลับเป็น working
          คำตอบที่ stream มาแล้วอยู่ในแผง
        from: panel
        to: you
        end: "turn ทำต่อ"
        sees: { kind: composer, state: working, header: working }
      do: >-
        action `waiting` ที่เป็น null ปิดการรอของ turn แถวการรอหายไป เวลาที่ทำงานกลับมา และหัวข้อกลับเป็น "working"
        reducer ไม่ล้าง `waiting` ด้วย `progress` หรือ `text` ข้อความของคำตอบจึงขึ้นก่อนหัวข้อจะเปลี่ยน
      sees: หัวข้อ "working" ปุ่ม Retry now หายไป ส่วนคำตอบที่ stream มาแล้วอยู่ในแผง
      ref: packages/extension/src/chat/rail.ts#headerOf
      end: { turn: continues }
---

เครือข่ายหลุดกับ rate limit ต่างจาก [ข้อผิดพลาดชั่วคราว](/scenarios/err/transient-retried/) ตรงที่ไม่ลองซ้ำเร็วๆ สามครั้งแล้วเลิก
แต่ turn **รอ** ได้นานเป็นนาที โดยยังไม่ล้ม และให้ผู้ใช้ตัดสินใจได้ตลอด

| | ออฟไลน์ | ถูกจำกัด (`limited`) |
| --- | --- | --- |
| ดูจาก | ไม่มีสถานะ HTTP, เชื่อมต่อไม่ได้ก่อน byte แรก | 429 หรือข้อความเรื่อง rate limit |
| รอครั้งแรก | 5 วินาที แล้วตรวจ host | ถึงเวลารีเซ็ต หรือ 15 วินาทีถ้าไม่รู้ |
| รอนานสุดต่อรอบ | 60 วินาที | 5 นาที |
| เลิกเมื่อ | 30 นาที | 15 นาที (เมื่อไม่รู้เวลารีเซ็ต) |
| กระทบ session อื่น | ไม่ | การรอสั้นๆ หยุดการเรียกของทุก session ใน engine |

สิ่งที่ควรสังเกต

- **การรอรอดจาก engine ที่ตาย** event `wait` อยู่ใน log engine ตัวใหม่เห็น log ที่จบด้วย `wait`
  แล้วเปิด turn ต่อแบบ `resume` เมื่อเป็นการรอออฟไลน์ จะตรวจ host ทันที
- **รีเซ็ตไกลเกิน 15 นาทีไม่ปลุกเอง** ค่า `short` ให้รอเองเฉพาะการรอไม่เกิน 15 นาที
  เกินกว่านั้นการรอไม่มีเวลาปลุก แถวสถานะขึ้น "Limited until ..." และรอผู้ใช้กด Retry now หรือ Stop
  ค่า `always` ให้ปลุกเองเสมอ ค่า `off` ไม่ปลุกเองเลย
- **Retry now ไม่ตรวจ host** ปุ่มนี้ส่งการเรียกทันที ถ้าเครือข่ายยังไม่กลับ การรอเดิมทำต่อ เวลารอรอบถัดไปยาวขึ้น และเวลาเลิกยังนับจากตอนเริ่มรอครั้งแรก
- **การรอไม่นับเป็นการเรียก model** ขีดจำกัดของรอบนับเฉพาะคำตอบที่ได้
- **Stop ได้ผลเดียวกันในทุกการรอของ gateway** ทาง "ผู้ใช้กด Stop" ในทัวร์นี้เกิดระหว่าง `nap` ของการรอเครือข่ายหรือ rate limit
  การรอสั้นๆ ก่อนลองใหม่ของ [ข้อผิดพลาดชั่วคราว](/scenarios/err/transient-retried/) (`backOff`) และการรอคิว slot ของผู้ให้บริการ (`slots.run`)
  ฟัง signal เดียวกัน ทุกทางคืน `ABORTED` แล้ว turn จบแบบ `stopped` เหมือนกัน

ถ้า engine ตายระหว่างรอ ดู [Engine ตายกลาง turn แล้วเริ่มใหม่](/scenarios/err/engine-crash-restart/)
