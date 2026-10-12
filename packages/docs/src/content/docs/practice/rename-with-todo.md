---
title: "Model เปลี่ยนชื่อทั้ง monorepo โดยวางแผนด้วย todo"
description: การรันจริง A07 งานสามขั้นที่ใช้ model 16 ครั้งใน turn เดียว model เดาชื่อไฟล์ผิด เขียน todo แก้สี่ไฟล์ในคำตอบเดียว รันเทสต์ แล้วตรวจซ้ำเกินจำเป็น
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: cli
  given:
    - รัน `gcode agent` แบบ non-interactive บน qwen3.8-flash (การรันจริง A07 รอบ fix-s1-1, engine ee34a245)
    - repo เป็น monorepo แบบ npm workspaces ที่ `core` ประกาศ `getUser` ส่วน `api` และ `web` เรียกใช้ และไม่มีคำสั่ง check ใน settings
  trigger: >-
    ผู้ใช้สั่ง "Rename getUser to fetchUser everywhere in the monorepo (core, api, web and their tests), make sure all
    tests still pass, and add a line about the rename under Unreleased in CHANGELOG.md."
  covers: [tool.todo-rename-run]
  related: [tool.todo-list, tool.parallel-read-batch, edit.applied-as-diff, turn.test-fix-loop]
  steps:
    - id: ask
      lane: user
      beat:
        title: "คุณของานสามอย่างในประโยคเดียว"
        text: >-
          เปลี่ยนชื่อทุกที่ ให้เทสต์ยังผ่าน และเขียน CHANGELOG งานแบบนี้ต้องใช้ tool หลายครั้งในหลายรอบของ loop
        from: you
        to: panel
      do: ผู้ใช้รัน `gcode agent` พร้อมคำสั่ง
      phase: idle

    - use: model-call
      beat:
        title: "Geno ส่ง request แรก พร้อม tool `todo`"
        text: >-
          คำอธิบายของ `todo` บอก model ให้ใช้มันเป็น call แรกเมื่องานมีสามขั้นขึ้นไป และยกตัวอย่างที่แทบตรงกับคำขอนี้:
          "rename it everywhere, make sure the tests pass, and add a changelog line"
        from: engine
        to: model
        sees:
          kind: payload
          direction: request
          source: docs/results/real-usecases/runs/A07-multi-step-todo/fix-s1-1/wire.jsonl.gz#line=1
          select: tools[8]
          highlight: [name, description]
          collapse: [input_schema]

    - id: survey
      lane: model
      beat:
        title: "Model สำรวจ repo ก่อน ยังไม่เขียน todo"
        text: >-
          model ไม่ได้เรียก `todo` เป็น call แรก มันขอ `list` กับ `grep` แล้วขอ `read` หกไฟล์ในคำตอบเดียว
          สองไฟล์ใน `web` เดาชื่อจาก `core` ผิด ไฟล์จริงชื่อ `profile.js` `read` ส่ง error กลับ
          model จึง `list` โฟลเดอร์ `web` แล้วอ่านใหม่ การสำรวจใช้ไปสี่รอบ
        from: model
        to: engine
        sees:
          kind: payload
          direction: tool_result
          source: docs/results/real-usecases/runs/A07-multi-step-todo/fix-s1-1/session.jsonl#seq=12
          highlight: [status, output]
          collapse: [timing]
      do: >-
        model ขอ `list` และ `grep` จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: survey-run
      lane: tool
      at: executor
      runs: 2
      do: >-
        `list` และ `grep` อ่านอย่างเดียว จึงรันพร้อมกันในชุดเดียว
      ref: packages/engine/src/drive.ts#runTools
      emits: [tool-result]

    - use: model-call

    - id: guess
      lane: model
      do: >-
        model ขอ `read` หกตัว สี่ตัวสำเร็จ สองตัวได้ "no such file or directory"
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: guess-run
      lane: tool
      at: executor
      runs: 6
      do: >-
        `read` หกตัวรันพร้อมกัน ตัวที่ไม่มีไฟล์ได้ผลเป็น `error` ซึ่งไม่หยุดตัวอื่นในชุด
      ref: packages/engine/src/drive.ts#runTools
      emits: [tool-result]

    - use: model-call

    - id: list-web
      lane: model
      do: >-
        model ขอ `list` ของ `packages/web`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: list-web-run
      lane: tool
      at: executor
      do: >-
        `list` ได้ `profile.js` และ `profile.test.js`
      ref: packages/engine/src/tools/index.ts#runExecutor
      emits: [tool-result]

    - use: model-call

    - id: read-web
      lane: model
      do: >-
        model ขอ `read` สองไฟล์ของ `web` ที่มีจริง
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: read-web-run
      lane: tool
      at: executor
      runs: 2
      do: >-
        `read` สองตัวรันพร้อมกัน
      ref: packages/engine/src/drive.ts#runTools
      emits: [tool-result]

    - use: model-call

    - id: plan
      lane: model
      beat:
        title: "Model เขียน todo สามข้อ"
        text: >-
          ใน call ที่ห้า model เขียนรายการตรงกับสามงานที่คุณขอ ข้อแรก in_progress ที่เหลือ pending
          Geno ตอบสั้นๆ ว่าอัปเดตรายการแล้ว ในแผงแชตของ VS Code รายการนี้จะปักไว้ให้คุณเห็นตลอด
        from: model
        to: engine
        sees:
          kind: payload
          direction: response
          source: docs/results/real-usecases/runs/A07-multi-step-todo/fix-s1-1/session.jsonl#seq=22
          select: content[-1].input
          highlight: ['items[0].status']
      do: >-
        model ขอ `todo` ด้วยรายการสามข้อ
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: plan-run
      lane: tool
      at: executor
      do: >-
        `todo` ตรวจรายการแล้วตอบ "Updated the todo list: 0 of 3 done, … in progress."
      ref: packages/core/src/todo.ts#TODO_SPEC
      emits: [tool-result]

    - use: model-call

    - id: edits
      lane: model
      beat:
        title: "Model แก้สี่ไฟล์ในคำตอบเดียว"
        text: >-
          model อ่านทุกไฟล์แล้ว จึงขอ `edit` สี่ตัวในคำตอบเดียว แต่ละตัวบอกข้อความเดิม (`old_str`) และข้อความใหม่
          ทั้งสี่สำเร็จ และผลบอกว่าไม่ต้องอ่านไฟล์ซ้ำ
        from: model
        to: engine
        sees:
          kind: payload
          direction: response
          source: docs/results/real-usecases/runs/A07-multi-step-todo/fix-s1-1/session.jsonl#seq=25
          select: content[1].input
          highlight: [path, old_str, new_str]
      do: >-
        model ขอ `edit` สี่ตัว: `core/src/user.js`, `api/src/routes.js`, `web/src/profile.js` และ `core/test/user.test.js`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: edits-run
      lane: tool
      at: executor
      runs: 4
      do: >-
        `edit` ทั้งสี่ตัวเขียนไฟล์ และตอบ "Edited … The file state is current in your context; no need to read it back."
      ref: packages/engine/src/tools/agent.ts#editExecutor
      emits: [tool-result]

    - use: model-call

    - id: check
      lane: model
      beat:
        title: "Model รันเทสต์เองเมื่อไม่มี `check`"
        text: >-
          model ขอ `grep` ซ้ำ (ไม่เหลือ `getUser`) กับ `check` แต่ workspace นี้ไม่ได้ตั้งคำสั่ง check ไว้
          ผลของ `check` บอกให้ใช้ `bash` แทน รอบถัดมา model จึงรัน `node --test` เทสต์ผ่านทั้งสี่ตัว
        from: model
        to: engine
        sees:
          kind: payload
          direction: tool_result
          source: docs/results/real-usecases/runs/A07-multi-step-todo/fix-s1-1/session.jsonl#seq=33
          highlight: [output]
          collapse: [timing]
      do: >-
        model ขอ `grep` และ `check`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: check-run
      lane: tool
      at: executor
      runs: 2
      do: >-
        `check` ไม่มีคำสั่งให้รัน จึงตอบ "This workspace has no check command. Run its tests or type checker with bash instead."
      ref: "packages/engine/src/tools/agent.ts#\"This workspace has no check command.\""
      emits: [tool-result]

    - use: model-call

    - id: tests
      lane: model
      do: >-
        model ขอ `bash` ด้วย `node --test`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: tests-run
      lane: tool
      at: shell
      do: >-
        `node --test` ไม่อยู่ในรายการปลอดภัย แต่ run แบบ non-interactive ไม่มีใครให้ถาม กฎ `unlisted` จึงปล่อยให้รันใน sandbox
        เทสต์ผ่าน 4 จาก 4
      ref: "packages/core/src/approval.ts#\"unlisted: {\""
      emits: [tool-result]

    - use: model-call

    - id: changelog
      lane: model
      beat:
        title: "Model เขียน CHANGELOG แล้วติ๊ก todo ครบ"
        text: >-
          สี่รอบถัดมา model อ่าน `CHANGELOG.md` เพิ่มบรรทัดใต้ Unreleased ดู `git diff --stat`
          แล้วเรียก `todo` อีกครั้งให้ทั้งสามข้อเป็น done
        from: model
        to: engine
        sees:
          kind: payload
          direction: tool_result
          source: docs/results/real-usecases/runs/A07-multi-step-todo/fix-s1-1/session.jsonl#seq=48
          highlight: [output]
          collapse: [timing, todo]
      do: >-
        model ขอ `read` `CHANGELOG.md`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: changelog-read
      lane: tool
      at: executor
      do: >-
        `read` ได้ `CHANGELOG.md` สามบรรทัด
      ref: packages/engine/src/tools/index.ts#runExecutor
      emits: [tool-result]

    - use: model-call

    - id: changelog-edit
      lane: model
      do: >-
        model ขอ `edit` ที่แทน `## Unreleased` ด้วยหัวข้อเดิมกับบรรทัดใหม่
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: changelog-edit-run
      lane: tool
      at: executor
      do: >-
        `edit` เขียน `CHANGELOG.md`
      ref: packages/engine/src/tools/agent.ts#editExecutor
      emits: [tool-result]

    - use: model-call

    - id: diff-stat
      lane: model
      do: >-
        model ขอ `bash` ด้วย `git diff --stat`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: diff-stat-run
      lane: tool
      at: shell
      do: >-
        `git diff --stat` รันใน sandbox ได้ห้าไฟล์ที่เปลี่ยน
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
      emits: [tool-result]

    - use: model-call

    - id: todo-done
      lane: model
      do: >-
        model ขอ `todo` ที่ทั้งสามข้อเป็น `done`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: todo-done-run
      lane: tool
      at: executor
      do: >-
        `todo` ตอบ "Updated the todo list: 3 of 3 done."
      ref: packages/core/src/todo.ts#TODO_SPEC
      emits: [tool-result]

    - use: model-call

    - id: recheck
      lane: model
      beat:
        title: "Model ตรวจซ้ำทั้งที่งานเสร็จแล้ว"
        text: >-
          รายการครบแล้ว แต่ model ยัง `grep` และรันเทสต์ซ้ำ แล้วสงสัยผล `grep` ของตัวเอง จึงใช้ `grep -rn` ใน `bash` อีกสองครั้ง
          ครั้งแรกได้ exit 1 เพราะ `grep -v` ไม่เหลืออะไร ครั้งที่สอง Geno ต่อโน้ตท้ายผลว่าครั้งหน้าให้ใช้ tool `grep`
        from: model
        to: engine
        sees:
          kind: payload
          direction: tool_result
          source: docs/results/real-usecases/runs/A07-multi-step-todo/fix-s1-1/session.jsonl#seq=59
          highlight: [output]
          collapse: [timing]
      do: >-
        model ขอ `grep` กับ `bash` ที่รันเทสต์ซ้ำ
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: recheck-run
      lane: tool
      at: executor
      runs: 2
      do: >-
        `grep` และ `bash` รันได้ผลเหมือนเดิม: เหลือ `getUser` แค่ในบรรทัด CHANGELOG และเทสต์ผ่าน 4 จาก 4
      ref: packages/engine/src/drive.ts#runTools
      emits: [tool-result]

    - use: model-call

    - id: recheck-2
      lane: model
      do: >-
        model ขอ `read` `CHANGELOG.md` กับ `bash` ที่มี `grep -rn … | grep -v CHANGELOG.md`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: recheck-2-run
      lane: tool
      at: shell
      runs: 2
      do: >-
        `bash` จบด้วย exit code 1 เพราะ `grep -v` ไม่เหลือบรรทัดให้พิมพ์ ผลจึงเป็น `error`
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
      emits: [tool-result]

    - use: model-call

    - id: recheck-3
      lane: model
      do: >-
        model ขอ `bash` ที่มี `grep -rn "getUser" packages/ … || echo "no matches in code"`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: note
      lane: tool
      at: shell
      do: >-
        คำสั่งนี้แค่ค้นเนื้อไฟล์ `fileToolNoter` จึงต่อโน้ต "[Geno] Next time, search file contents with the grep tool, not grep -r or rg."
        ท้ายผล โน้ตของแต่ละ tool ขึ้นครั้งเดียวต่อ session
      ref: packages/core/src/shell-intent.ts#fileToolNoter
      emits: [tool-result]

    - use: model-call

    - id: answer
      lane: model
      beat:
        title: "Model สรุปงานและจบ turn"
        text: >-
          call ที่ 16 เป็นข้อความอย่างเดียว บอกว่าเปลี่ยนชื่อที่ไหน เทสต์ผ่าน และเพิ่มบรรทัด CHANGELOG แล้ว
          request สุดท้ายอ่านจาก cache ได้ 11,127 token ทั้ง turn ใช้ $0.024
        from: model
        to: engine
        end: จบ turn
        sees:
          kind: payload
          direction: response
          source: docs/results/real-usecases/runs/A07-multi-step-todo/fix-s1-1/session.jsonl#seq=61
          select: content[-1]
          highlight: [text]
      do: >-
        model ตอบเป็นข้อความอย่างเดียว จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - id: done
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `done(end_turn)`
      ref: packages/core/src/loop.ts#loopStep
      emits: [end_turn]
      phase: ending
      end: { turn: done, reason: end_turn }
---

## ผลของรอบนี้

check ของ case ผ่านทุกข้อ: model ใช้ todo และจบด้วยทุกข้อ done (`keeps-todo`) เทสต์ทุก package ผ่าน (`tests-pass`)
ไม่เหลือ `getUser` ใน `packages` (`rename-complete`) และ CHANGELOG มี `fetchUser` (`changelog`)
ทั้ง run นับว่าไม่ผ่าน เพราะ check กลาง `dedicated-file-tools` จับ `grep -rn` สองครั้งท้าย run ที่ควรเป็น tool `grep` (`result.json` ของรอบ fix-s1-1)

รอบนี้เป็นรอบเดียวใน 10 รอบของ A07 ที่ model เรียก `todo` อีกเก้ารอบเปลี่ยนชื่อได้ครบและเทสต์ผ่านเหมือนกัน แต่ไม่มีรายการ
(`keeps-todo` ใน `result.json` ของแต่ละรอบ) FIXES.md บันทึก P-11 ว่าการเขียนคำอธิบายของ `todo` ใหม่ยังไม่แก้
และมองว่าเป็นข้อจำกัดของ model ที่งานขนาดนี้

## ทำไมถึงเป็นแบบนี้

- **loop ไม่รู้ว่างานมีกี่ขั้น** ทุกรอบเหมือนกัน: model ขอ tool Geno รัน แล้วส่งผลกลับ งาน 16 รอบนี้คือ loop เดียวกับใน
  [Agent loop](/foundations/agent-loop/) ที่วนนานขึ้น `todo` เป็นแค่ tool ตัวหนึ่ง มันไม่บังคับลำดับงาน
  มันเก็บรายการไว้ใน log ให้ทั้ง model และคุณเห็น
- **คำอธิบายของ tool แนะนำได้ บังคับไม่ได้** คำอธิบายของ `todo` บอกให้เรียกเป็น call แรก model เรียกใน call ที่ห้า
  ส่วนที่ Geno ทำเองได้คือเตือน: `todoReminder` ส่งรายการที่ค้างกลับไปเมื่อ model ไม่แตะมันครบ 10 รอบ ใน run นี้ไม่ถึงเกณฑ์นั้น
- **ผลที่ผิดพลาดก็คือผลของ tool** `read` ไฟล์ที่ไม่มี และ `bash` ที่ exit 1 ไม่ทำให้ turn จบ model อ่าน error แล้วเลือกทางใหม่เอง
  ดู [ผลของ tool ส่งกลับอย่างไร](/foundations/tool-results/)
- **โน้ตท้ายผลสอน model ระหว่างทาง** `[Geno] Next time, …` มาจากตาราง `FILE_TOOL_NOTES` ที่รู้ว่าคำสั่ง shell ไหนแค่อ่านหรือค้นไฟล์
  โน้ตอยู่ในผลของ tool จึงไม่เปลี่ยน system prompt และไม่ทำให้ cache ส่วนต้นเสีย

อ่านต่อ:

- [Tool คือสัญญา](/foundations/tools-are-contracts/) ทำไมคำอธิบายของ tool เปลี่ยนพฤติกรรมของ model ได้
- [Memory และ context window](/foundations/memory-and-context/) request ที่โตขึ้นทุกรอบจะเป็นอย่างไรเมื่อยาวเกิน
- [Model อัปเดตรายการ todo](/scenarios/tool/todo-list/) รายการ todo ในแผงแชต
