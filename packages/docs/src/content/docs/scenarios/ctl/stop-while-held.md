---
title: "กด Ctrl-C ใน CLI ขณะรอรายงานของ subagent"
description: ใน CLI โมเดลจบ turn แล้วแต่ turn ยังเปิดรอรายงานของลูกที่รันเบื้องหลัง ผู้ใช้กด Ctrl-C การรอจบ ลูกถูกหยุด รายงานไม่ถูกรับ และ process ออกด้วย 130
tableOfContents: false
sidebar:
  order: 8
scenario:
  surface: cli
  given:
    - ผู้ใช้รัน `gcode agent "สำรวจว่าโมดูลไหนไม่มีเทสต์"` ในเทอร์มินัล
    - "โมเดลเรียก `agent` ให้ `explore` ทำงานแบบ `background: true` แล้วจบคำตอบด้วย `end_turn` ว่าจะรอผล"
    - CLI ไม่มีตัวปลุก ไม่มีอะไรมาเปิด session ทีหลังได้ turn จึงต้องเปิดรอรายงานเอง
  trigger: >-
    ผู้ใช้กด Ctrl-C ระหว่างที่เทอร์มินัลรออยู่
  covers: [ctl.stop-while-held-for-child]
  related: [bg.cli-holds-turn, cli.agent-run, sub.parent-stop-with-children, ctl.stop-while-streaming]
  steps:
    - id: done
      lane: loop
      at: step
      beat:
        title: "Geno ยังไม่จบ turn เพราะรอรายงาน"
        text: >-
          โมเดลส่งงานให้ subagent ชื่อ explore ทำเบื้องหลัง แล้วจบคำตอบว่าจะรอผล ใน CLI ไม่มีอะไรมาปลุก session ทีหลัง
          Geno จึงยังไม่จบ turn แต่เปิดรอรายงานฉบับนั้นเอง
        from: engine
        to: engine
      do: >-
        `loopStep` ให้ `done(end_turn)` แต่ `holdsTurnOpen` เห็นว่าลูกเบื้องหลังยังติดรายงานอยู่หนึ่งฉบับ
        และพื้นผิวนี้ไม่มี `wakeLater` loop จึงไม่จบ แต่รอที่ `arrival` ของ inbox
      ref: packages/core/src/steer.ts#holdsTurnOpen
      phase: held

    - id: waiting
      lane: panel
      at: terminal
      beat:
        title: "เทอร์มินัลค้างโดยไม่บอกว่ารอ"
        text: >-
          คำตอบของโมเดลพิมพ์ออกมาแล้ว แต่ไม่มีบรรทัดไหนบอกว่ากำลังรอ และเทอร์มินัลยังไม่คืน prompt
        from: panel
        to: you
        sees: { kind: message, from: geno, text: ผมให้ explore สำรวจอยู่ เดี๋ยวสรุปให้เมื่อได้ผล }
      do: >-
        คำตอบของโมเดลพิมพ์ออก stdout ไปแล้ว ไม่มีบรรทัดอะไรบอกว่ากำลังรอ เทอร์มินัลยังไม่คืน prompt
      sees: ข้อความ "ผมให้ explore สำรวจอยู่ เดี๋ยวสรุปให้เมื่อได้ผล" แล้วเคอร์เซอร์ค้างอยู่
      ref: packages/engine/src/drive.ts#terminalSurface

    - id: child
      lane: child@explore
      at: model
      beat:
        title: "Subagent ยังอ่านไฟล์อยู่"
        text: >-
          explore ทำงานต่อใน session ของตัวเอง ยังไม่ได้เขียนรายงาน
        from: model
        to: model
      alongside: true
      do: >-
        ลูกยังอ่านไฟล์อยู่ใน session ของตัวเอง
      ref: packages/core/src/subagent.ts#childSystemPrompt

    - id: press
      lane: user
      beat:
        title: "คุณกด Ctrl-C"
        text: >-
          คุณไม่อยากรอแล้ว Ctrl-C ครั้งแรกสั่งให้ Geno หยุด turn ครั้งที่สองจะฆ่า process ทันที
        from: you
        to: panel
      do: ผู้ใช้กด Ctrl-C

    - id: sigint
      lane: loop
      at: agent
      beat:
        title: "Geno เลิกรอทันที"
        text: >-
          การรอรายงานฟังสัญญาณหยุดเดียวกับ turn จึงจบทันที Geno บันทึกว่าคุณเป็นคนหยุด
        from: engine
        to: engine
      do: >-
        SIGINT ตัวแรกสั่ง abort `AbortController` ที่ `interrupts()` ให้ไว้ตอนเริ่มรอบ (ตัวที่สองจะฆ่า process ตามปกติของ Node)
      ref: "packages/engine/src/cli.ts#\"process.once('SIGINT', () => controller.abort());\""

    - id: wake
      lane: loop
      at: drive
      do: >-
        `arrival` ฟัง signal เดียวกันจึงคืนทันที `drive` บันทึก event `error` ชนิด `abort` "interrupted by the user" แล้ววนกลับไปถาม `loopStep`
      ref: "packages/engine/src/drive.ts#\"await held.arrival(signal);\""
      emits: [error, abort, interrupted by the user]
      phase: ending

    - id: ended
      lane: loop
      at: step
      beat:
        title: "Geno จบ turn"
        text: >-
          Geno เห็นว่าคุณหยุด จึงจบ turn และไม่ถือ turn ไว้รออีก ทางรับข้อความของ turn ปิด
        from: engine
        to: engine
      do: >-
        `loopStep` เห็น error `abort` จึงให้ `done(error)` การรอไม่ถือ turn อีกเพราะการรอเกิดเฉพาะหลัง `done(end_turn)`
        `end()` ปิด inbox
      ref: packages/core/src/loop.ts#ERROR_REASON

    - id: stop-children
      lane: loop
      at: agent
      beat:
        title: "Geno หยุด subagent ทุกตัว"
        text: >-
          turn ไม่ได้จบด้วยคำตอบ และ CLI ไม่มีตัวปลุก Geno จึงหยุด subagent เบื้องหลังทุกตัว สิ่งที่ explore
          พบไม่ไปถึงแชตหลัก Geno รอให้มันจบก่อนปิด sandbox
        from: engine
        to: model
      do: >-
        `finally` ของ `runAgent` เรียก `stopBackground` เมื่อ turn ไม่ได้จบด้วย `end_turn` หรือไม่มีตัวปลุก (ที่นี่เป็นทั้งสองอย่าง):
        abort ลูกเบื้องหลังทุกตัว และตั้งว่ารายงานของพวกมันไม่มีใครฟังแล้ว แล้วรอให้ลูกจบก่อนปิด sandbox
      ref: "packages/engine/src/subagents.ts#\"stopBackground: () => {\""

    - id: child-ends
      lane: child@explore
      at: loop
      do: >-
        รอบของลูกถูก abort จบแบบ `cancelled` สิ่งที่มันพบไม่ไปถึงแม่
      ref: packages/core/src/subagent.ts#childEndOf
      emits: [cancelled]

    - id: exit
      lane: panel
      at: terminal
      beat:
        title: "เทอร์มินัลคืน prompt พร้อมรหัส 130"
        text: >-
          Geno พิมพ์บรรทัด usage แล้ว process ออกด้วยรหัส 130 ซึ่งแปลว่าถูกขัด script ที่เรียก CLI จึงแยกออกได้
        from: panel
        to: you
        end: "คุณหยุด process ออก 130"
        sees: "บรรทัด \"usage: ... turns=3\" แล้ว prompt ของเชลล์กลับมา `echo $?` ได้ 130"
      do: >-
        `finish` ไม่เพิ่มข้อความ error เพราะ event สุดท้ายเป็น `abort` อยู่แล้ว พิมพ์บรรทัด usage แล้ว process ออกด้วย
        `EXIT_CODES.abort`
      sees: >-
        บรรทัด "usage: ... turns=3" แล้ว prompt ของเชลล์กลับมา `echo $?` ได้ 130
      ref: packages/engine/src/chat.ts#EXIT_CODES
      end: { turn: stopped, reason: abort }
---

การถือ turn ไว้รอลูกเกิดเฉพาะที่ไม่มีตัวปลุก: CLI หรือ engine ที่ตั้ง `GCODE_AUTO_WAKE=off`
ใน VS Code ปกติ turn จบทันทีที่โมเดลจบ และรายงานของลูกปลุก session ทีหลัง ดู
[ลูกเบื้องหลังรายงานแล้วปลุกเซสชัน](/scenarios/bg/child-wakes-parent/)

สิ่งที่ควรสังเกต

- **การรอไม่มีอะไรบอกบนจอ** เทอร์มินัลแค่ไม่คืน prompt ผู้ใช้ที่ไม่รู้ว่ามีลูกเบื้องหลังอาจคิดว่า process ค้าง
- **Ctrl-C ทิ้งงานของลูก** `stopBackground` ตั้งให้รายงานไม่มีใครฟัง ลูกที่ใกล้เสร็จก็ไม่ได้ส่งผลกลับ
  และ turn ของแม่จบไปก่อนที่ใครจะได้อ่านมัน
- **exit code บอกว่าถูกหยุด** 130 มาจาก `EXIT_CODES.abort` ไม่ใช่ 0 แม้โมเดลจะจบคำตอบของมันไปแล้ว

Stop ใน VS Code ระหว่างโมเดลเขียน ดู [กด Stop ขณะ model กำลังเขียน](/scenarios/ctl/stop-while-streaming/)
