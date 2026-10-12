# ทดลองใช้ Geno ผ่านเว็บแบบผู้ใช้จริง รอบที่ 1 (2026-10-11)

สร้าง `baht-tracker` เว็บบันทึกรายจ่ายเป็นเงินบาท (Node ล้วน, JSON, node:test) จากโฟลเดอร์เปล่า โดยคุยผ่าน Geno web (branch `web-host`) และเปิด VS Code ไว้ที่ project เดียวกัน โมเดล qwen3.8-flash ใช้ HOME แยก ค่าใช้จ่ายรวมประมาณ $0.67

ผลลัพธ์: แอปใช้งานได้จริง เพิ่ม/ลบ/สรุปตามหมวดถูกต้อง เทสผ่าน 34/34 (รอบ export ผ่าน 45/45 ก่อนถูก rewind ทิ้งตามแผนทดสอบ)

## ความสามารถที่ทดสอบ

| ความสามารถ | ผล |
|---|---|
| Plan mode + ปุ่ม Start building | ใช้ได้ |
| การ์ดขออนุญาต Allow, Always allow, Deny, No and tell the agent | ใช้ได้ แต่ดู B2 และ B3 |
| การ์ดคำถาม (3 แท็บ, ตัวอย่าง, คำตอบเอง) | ใช้ได้ ดี |
| Todo list | แสดงได้ แต่อัปเดตช้า (U4) |
| Steer กลางเทิร์น (Send now) | ส่งถึงและทำตาม แต่หาปุ่มยาก (U3) |
| Stop, Continue | ใช้ได้ |
| @mention ไฟล์ (rg) | ใช้ได้ |
| เซิร์ฟเวอร์ background | รันได้ อยู่รอดหลัง Stop แต่ตัวบอกสถานะหาย (U6) |
| Rewind, Restore files | ใช้ได้หลังแก้ B1 ไฟล์บนดิสก์และใน VS Code ย้อนจริง |
| Undo ทั้งเทิร์น, Keep/Undo ราย hunk | ใช้ไม่ได้บนเว็บ (W1) |
| Auto mode, web_fetch, mermaid diagram | ใช้ได้ |
| /compact | ใช้ได้ (102k เป็น 44k token) แต่แสดงข้อความผิด (U8) |
| Memory | ไม่บันทึก (M4) |
| VS Code เปิดคู่กัน | เห็นไฟล์ใหม่และไฟล์ที่ rewind ทันที |
| ไม่ได้ทดสอบ | skills, hooks, MCP, lanes, arena, spinoff, schedules (เวลาหมดก่อน) |

## บั๊ก

- **B1 (แก้แล้ว, 5cd905a5) session อ่านไม่ได้หลังกด "No, and tell the agent…"** engine เขียน `approval.comment` ลง log แต่ schema ใน `packages/engine/src/sessions.ts` ไม่รู้จัก key นี้ ทุกการอ่าน session นั้นจึงพัง: rewind ขึ้น Internal error, wake อ่านไม่ได้, การ resume จะพังด้วย เกิดใน VS Code เหมือนกัน
- **B2 การ์ดขออนุญาตแสดงแค่ชิ้นส่วนของคำสั่ง** for-loop ขึ้นเป็น `do node --check $f` และ `echo scan exit: $?` ผู้ใช้ไม่เห็นคำสั่งเต็มที่กำลังอนุญาต และ Always allow จะบันทึกกฎ `do node` ซึ่งไม่มีความหมาย ควรแสดงคำสั่งเต็มและเน้นส่วนที่ติด และตัด keyword ของ shell (`do`, `then`) ออกจากกฎ
- **B3 คำสั่งปลอดภัยต้องขออนุญาต** `node --version` และ `echo` อยู่นอก safe list ใน Plan mode สองคำสั่งแรกถูกปฏิเสธจนโมเดลเสียรอบ
- **B4 ข้อความ "Geno stopped without a reply" หลัง /compact** คำสั่งที่ไม่มีคำตอบจากโมเดลไม่ควรแสดงเป็นความล้มเหลวพร้อม Continue/Retry

## เวอร์ชันเว็บ

- **W1 Undo และ Keep/Undo แสดงแค่ toast "In VS Code: …"** engine มี rewind แล้ว เว็บควรเรียก `REWIND_TURN_METHOD` และการ review ราย hunk ผ่าน engine แทน
- **W2 แบนเนอร์ gh ทับ transcript** แถว Thinking และ file chips ล่างสุดถูกบัง
- **W3 แบนเนอร์ "Run gh auth login" ขึ้นใน repo ใหม่ที่ไม่มี remote**

## UX

- **U1 ปุ่มสำเร็จรูปส่งข้อความภาษาอังกฤษ** "Go ahead with the plan." และ "Continue where you stopped…" ทำให้โมเดลเปลี่ยนไปตอบภาษาอังกฤษทั้งที่ผู้ใช้พิมพ์ไทย
- **U2 Enter ระหว่างทำงานแค่เข้าคิว** การ steer ต้องกดปุ่มลูกศรที่ไม่มีป้าย
- **U3 ชิป Queued ซ้อนกับแบนเนอร์**
- **U4 Todo ค้าง** "0 of 9" ขณะเขียนไฟล์ไป 3 ไฟล์แล้ว และเทิร์นจบที่ "7 of 9" แล้วไปโผล่เป็น "from an earlier turn" ในเทิร์นถัดไป
- **U5 ตำแหน่ง scroll กระโดด** หลัง rewind ไปอยู่บนสุดและไม่ตามเทิร์นใหม่ ไดอะแกรม mermaid จับ mouse wheel ทำให้เลื่อน transcript ไม่ได้เมื่อเมาส์อยู่บนไดอะแกรม
- **U6 ตัวบอก "1 running" หายไป** ทั้งที่เซิร์ฟเวอร์ bg-2 ยังรันอยู่
- **U7 เมนู rewind เปิดทับใต้ composer** รายการล่างถูกตัด และ Escape ไม่ปิด
- **U8 /compact กับ /memory ต้องกด Enter สองครั้ง** ครั้งแรกเลือกในเมนู ครั้งที่สองส่ง
- **U9 a11y** ตัวเลือกในการ์ดคำถามไม่มีชื่อสำหรับ screen reader ลิงก์ Undo หาไม่เจอใน accessibility tree

## พฤติกรรมโมเดล (qwen3.8-flash)

- **M1 อักษรภาษาอื่นหลุดเข้าโค้ดภาษาไทย** `ไม่รู้ຈัก` (ลาว), `boş` (ตุรกี), `的空` ในแผน, `ได้แ概您的` ในคำตอบ โมเดลรู้ตัวและรัน `node -e` สแกน 4 ครั้ง ทุกครั้งต้องอนุญาต
- **M2 ใช้ `sed -i` แก้ไฟล์** ข้าม edit tool ทำให้ไม่มี diff และ undo ต้องปฏิเสธพร้อมบอก
- **M3 ไม่ใช้ explore subagent ตามที่สั่ง** และพยายามสร้างไฟล์ fixture ทั้งที่บอกว่ายังไม่ต้องแก้โค้ด
- **M4 "จำไว้นะ" ไม่ถูกบันทึกเป็น memory** ตอบว่าจะจำ "ตลอดเซสชันนี้" และหน้า Memory ยังว่าง
- **M5 edit พัง 2 ครั้งแต่กู้ได้** `edit needs new_str as a string` และสร้างไฟล์ใหม่โดยไม่ใส่ `create: true`
- ข้อดี: แผนละเอียด, การ์ดคำถามดี, เทสครอบคลุม, รู้ตัวว่าไฟล์ถูก rewind
