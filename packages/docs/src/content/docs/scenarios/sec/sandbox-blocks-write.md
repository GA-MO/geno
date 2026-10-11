---
title: sandbox กันคำสั่งที่ได้รับอนุญาตแล้ว
description: ผู้ใช้อนุญาตคำสั่งแล้ว แต่คำสั่งเขียนนอก workspace อ่านไฟล์กุญแจ หรือออกเน็ต sandbox ปฏิเสธ คำสั่งล้มด้วย exit code และโมเดลทำต่อ
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - เปิด Geno ในโหมด Ask ไม่ได้ตั้ง `gcode.sandbox.allowedDomains` (ค่าเริ่มต้นคือไม่อนุญาตโฮสต์ใดเลย)
    - โมเดลขอรัน `bash` ด้วยคำสั่งที่ต้องขออนุญาต และผู้ใช้กด Allow once บนการ์ดแล้ว
  trigger: >-
    `settle` บันทึกว่าผู้ใช้อนุญาต และคำสั่งกำลังจะรัน
  covers: [sec.sandbox-blocks-write, sec.sandbox-blocks-network]
  related: [perm.ask-allow, tool.bash-nonzero-exit, perm.secret-read, perm.read-outside-workspace]
  steps:
    - id: allowed
      lane: policy
      at: settle
      do: >-
        `settle` บันทึก `decidedBy: user, verdict: allow` แล้ว `approveCommand` คืนบันทึกนั้น
        การอนุญาตตอบคำถามว่าให้รันไหม แต่ไม่ได้ขยายสิ่งที่คำสั่งแตะได้
      ref: packages/engine/src/tools/agent.ts#settle
      phase: running-tools

    - id: wrap
      lane: tool
      at: sandbox
      do: >-
        `sandbox.run` ห่อคำสั่งด้วย `SandboxManager.wrapWithSandbox` พร้อมกฎไฟล์ของคำสั่งนี้: เขียนได้เฉพาะ workspace
        กับโฟลเดอร์ชั่วคราว อ่านไม่ได้ในที่เก็บกุญแจของ home (`~/.ssh` และที่คล้ายกัน) และ path ที่กฎ deny ของ workspace ระบุ
        ส่วนเครือข่ายผ่าน proxy ของ sandbox ที่ปล่อยเฉพาะ loopback กับโฮสต์ใน `GCODE_SANDBOX_ALLOWED_DOMAINS`
      ref: packages/engine/src/sandbox.ts#sandboxPolicy

    - id: touch
      lane: tool
      at: shell
      do: >-
        `runShell` เริ่มคำสั่งใน process group ของตัวเอง ภายใต้ sandbox ของระบบปฏิบัติการ
      ref: packages/engine/src/process.ts#runShell
      fork:
        ask: คำสั่งพยายามแตะอะไร
        options:
          - id: write
            label: เขียนนอก workspace
            then: failed
            steps:
              - lane: tool
                at: sandbox
                do: >-
                  `npm install -g typescript` พยายามเขียนลงโฟลเดอร์ global ของ npm นอก workspace
                  sandbox ปฏิเสธการเขียน npm พิมพ์ error ว่า "operation not permitted" แล้วจบด้วย exit code ที่ไม่ใช่ 0
                ref: "packages/engine/src/sandbox.ts#\"writable: await withRealPaths([input.workspace, input.tempDir\""

          - id: read-key
            label: อ่านไฟล์กุญแจ
            then: failed
            steps:
              - lane: tool
                at: sandbox
                do: >-
                  `cat ~/.ssh/id_ed25519.pub` พยายามอ่านใน `~/.ssh` ซึ่งอยู่ใน `denyRead` sandbox ปฏิเสธการอ่าน
                  `cat` พิมพ์ "Operation not permitted" และจบด้วย exit code 1
                ref: packages/engine/src/tools/context.ts#credentialPlacesOf

          - id: network
            label: ออกเน็ต
            then: failed
            steps:
              - lane: tool
                at: sandbox
                do: >-
                  `curl https://api.github.com/repos/acme/app` ต้องผ่าน proxy ของ sandbox โฮสต์นี้ไม่อยู่ใน allowlist
                  proxy ไม่ยอมต่อให้ คำขอไม่ออกจากเครื่อง `curl` จบด้วย exit code ที่ไม่ใช่ 0
                ref: packages/engine/src/sandbox.ts#sandboxDomainsOf

    - id: failed
      lane: tool
      at: executor
      do: >-
        `bash` ประกอบผล: บรรทัดแรก `Exit code 1` ตามด้วยสิ่งที่คำสั่งพิมพ์ แล้วปิดด้วย `[exit code 1]`
        สถานะของผลเป็น `error` บันทึกว่าผู้ใช้อนุญาตไว้ยังติดไปกับผล ไม่มี event พิเศษที่บอกว่า sandbox เป็นคนกัน
      ref: packages/core/src/tools.ts#commandFailureLine
      emits: [Exit code, error]

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลอ่านข้อความ error แล้วเลือกทางอื่น
        เช่นติดตั้งเป็น dev dependency ใน workspace แทน หรือบอกผู้ใช้ว่าต้องรันคำสั่งนี้เอง
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

การอนุญาตกับ sandbox เป็นคนละชั้นกัน การอนุญาต (กฎ การ์ด classifier ของ Auto) ตัดสินว่า**ให้รันไหม**
ส่วน sandbox กำหนดว่าคำสั่งที่รันแล้ว**แตะอะไรได้** และไม่มีปุ่มไหนในแผงแชตที่ขยาย sandbox ระหว่าง turn

| คำสั่งพยายาม | sandbox | ปรับได้ที่ |
| --- | --- | --- |
| เขียนนอก workspace และโฟลเดอร์ชั่วคราว | ปฏิเสธ | ไม่มี (lane ได้ที่เขียนเพิ่มเฉพาะส่วนของ git ที่ใช้ร่วมกัน) |
| อ่านที่เก็บกุญแจใน home | ปฏิเสธ | กฎ deny path เพิ่มที่ห้ามอ่านได้ ลดไม่ได้ |
| ต่อโฮสต์ภายนอก | ปฏิเสธ | `gcode.sandbox.allowedDomains` (เช่น `registry.npmjs.org`) |
| ต่อ `localhost` | อนุญาต | ไม่ต้องตั้ง |

สิ่งที่ควรสังเกต

- **error มาจากคำสั่งเอง** Geno ไม่ได้แปลข้อความให้ โมเดลเห็นข้อความเดียวกับที่คำสั่งพิมพ์ เช่น "Operation not permitted"
  ยกเว้น `kill` ที่ส่งสัญญาณถึง process ที่ไม่ได้เริ่มใน call เดียวกัน ซึ่งได้โน้ต
  "[Geno] The sandbox lets a command signal only what the same call started." พร้อมคำแนะนำให้ใช้ `task_stop`
- **allowlist เป็นของ engine ทั้งตัว** sandbox-runtime มี proxy เดียวต่อ process ทุก session ใน engine เดียวกันใช้ allowlist เดียวกัน
  การเปลี่ยนค่าจึงทำให้ engine เริ่มใหม่
- **ตรวจก่อนก็ยังกันซ้ำ** คำสั่งอย่าง `curl` ถูกจัดเป็นการดาวน์โหลดและต้องขออนุญาตก่อน ส่วน sandbox กันอีกชั้นหลังจากอนุญาตแล้ว
