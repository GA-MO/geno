---
title: "คำศัพท์"
description: คำศัพท์ของ agent harness ทุกคำที่เอกสารนี้ใช้ อธิบายสั้นๆ เทียบกับ REST เมื่อเทียบได้ และลิงก์ไปหน้าที่แสดงของจริง
---

หน้านี้รวมทุกคำที่เอกสารใช้แต่คนที่เขียน REST API มาไม่จำเป็นต้องรู้จัก
คำเรียงตามลำดับที่คุณจะเจอเมื่ออ่านบท "พื้นฐาน" ตั้งแต่ต้น คอลัมน์ขวาลิงก์ไปหน้าที่แสดงคำนั้นกับของจริง

## Model และ request

| คำ | ความหมาย | ดูที่ |
| --- | --- | --- |
| **model** (AI model, LLM) | โปรแกรมของผู้ให้บริการที่อ่านข้อความแล้วเขียนข้อความตอบ Geno เรียกมันผ่าน HTTP API ที่ไม่เก็บ state เหมือน REST endpoint ที่ลืมทุกอย่างหลังตอบ request | [Model คือ API call หนึ่งครั้ง](/foundations/model-is-one-call/) |
| **ผู้ให้บริการ** (provider) | บริษัทที่รัน model ให้เรียกผ่าน API เช่น Model Studio Anthropic และ OpenRouter Geno เรียกด้วย API key ของคุณ | [ส่วนประกอบของ Geno](/foundations/parts-of-geno/) |
| **qwen3.8-flash** | model ที่ใช้ในการรันจริงส่วนใหญ่ของเอกสารนี้ รันบน Model Studio การรันที่ชื่อ `sonnet-1` ใช้ Claude Sonnet 5.5 แทน | [ผ่า request หนึ่งก้อน](/foundations/anatomy-of-a-request/) |
| **prompt** | ข้อความที่คุณพิมพ์ส่งให้ Geno | [Model คือ API call หนึ่งครั้ง](/foundations/model-is-one-call/) |
| **request** | JSON หนึ่งก้อนที่ Geno POST ไปหา model field หลักคือ `model` `max_tokens` `system` `tools` และ `messages` | [ผ่า request หนึ่งก้อน](/foundations/anatomy-of-a-request/) |
| **token** | หน่วยที่ model ใช้นับข้อความ ประมาณหนึ่งคำหรือส่วนหนึ่งของคำ ความยาวของ request เพดานของคำตอบ และค่าใช้จ่าย นับเป็น token ทั้งหมด | [ผ่า request หนึ่งก้อน](/foundations/anatomy-of-a-request/) |
| **system prompt** (`system`) | ข้อความคู่มือที่บอก model ว่ามันเป็นใครและควรทำงานอย่างไร ของ Geno คงที่ตลอด session | [Model รู้ได้อย่างไรว่าต้องทำอะไร](/foundations/how-the-model-knows/) |
| **`messages`** | รายการข้อความของบทสนทนา สลับระหว่าง `user` กับ `assistant` (คำตอบของ model) Geno สร้างใหม่จาก session log ทุกครั้งที่เรียก model | [Model คือ API call หนึ่งครั้ง](/foundations/model-is-one-call/) |
| **`tools`** | รายการ tool ที่ model ขอเรียกได้ใน request นี้ แต่ละตัวมีชื่อ คำอธิบาย และ JSON Schema ของ input | [Tool คือสัญญา](/foundations/tools-are-contracts/) |
| **stream** | คำตอบที่ส่งมาทีละชิ้นระหว่างที่ model ยังเขียน แทนการส่งก้อนเดียวตอนจบ เหมือน HTTP response แบบ Server-Sent Events ที่แต่ละ event มี JSON เล็กๆ เช่น `text_delta` (ข้อความไม่กี่คำ) และ `message_delta` (เหตุผลที่หยุด) | [Model ตอบกลับอะไรได้บ้าง](/foundations/what-comes-back/) |
| **thinking** | บล็อกที่ model คิดก่อนตอบ Geno เก็บและส่งกลับใน request ถัดไป แต่ไม่แสดงในแชต | [Model ตอบกลับอะไรได้บ้าง](/foundations/what-comes-back/) |
| **effort** | ระดับที่บอก model ว่าให้คิดหนักแค่ไหน ตั้งแต่ `low` ถึง `max` Geno ส่งเฉพาะ model ที่รองรับ | [เปลี่ยน effort หรือเปลี่ยน model](/scenarios/sess/model-effort/) |
| **`stop_reason`** | field ท้ายคำตอบที่บอกว่า model หยุดเพราะอะไร เหมือน field สถานะใน response ที่บอกว่างานจบหรือยังรออะไรอยู่ ค่าหลักคือ `tool_use` (รอผลของ tool) และ `end_turn` (ตอบจบแล้ว) | [Model ตอบกลับอะไรได้บ้าง](/foundations/what-comes-back/) |
| **`max_tokens`** | เพดานความยาวของคำตอบหนึ่งครั้ง นับเป็น token ถ้าคำตอบชนเพดาน `stop_reason` เป็น `max_tokens` | [คำตอบของ model ชนเพดาน output](/scenarios/mstop/max-tokens/) |
| **`tool_choice`** | field ที่บังคับให้ model เรียก tool ตัวหนึ่ง หรือห้ามเรียก tool เลย ปกติ Geno ไม่ส่ง | [ผ่า request หนึ่งก้อน](/foundations/anatomy-of-a-request/) |
| **context window** | จำนวน token สูงสุดที่ model อ่านได้ใน request เดียว รวมคำตอบด้วย บทสนทนาที่ยาวเกินต้องย่อก่อน | [Memory และ context window](/foundations/memory-and-context/) |
| **prompt cache** (`cache_control`) | ผู้ให้บริการจำส่วนต้นของ request ที่เพิ่งเห็นไว้ชั่วคราว request ถัดไปที่ขึ้นต้นด้วยไบต์เดิมจึงอ่านส่วนนั้นเร็วและถูกกว่า คล้าย HTTP cache ที่ใช้ได้เมื่อ key ตรงกันเป๊ะ ต่างกันตรงที่ key คือส่วนต้นของ request `cache_control` คือจุดที่บอกว่าให้ cache ถึงตรงไหน | [Memory และ context window](/foundations/memory-and-context/) |
| **wire** | ส่วนของ engine ที่แปลง request เป็นรูปแบบที่ผู้ให้บริการรับแล้วส่งออกไป มีสองรูปแบบ คือ Anthropic Messages และ OpenAI Chat Completions ส่วนอื่นของ Geno ใช้รูปแบบ Anthropic อย่างเดียว | [ผ่า request หนึ่งก้อน](/foundations/anatomy-of-a-request/) |
| **gateway** | ส่วนของ engine ที่เรียก model หนึ่งครั้ง อ่าน stream จนจบ และ retry เมื่อผู้ให้บริการล้มชั่วคราว แล้วคืนคำตอบเต็มให้ loop | [ผู้ให้บริการล้มชั่วคราว Geno retry เอง](/scenarios/err/transient-retried/) |
| **retry** | การส่ง request เดิมซ้ำเมื่อเครือข่ายหลุดหรือผู้ให้บริการตอบ error ชั่วคราว ถ้าออฟไลน์หรือโดน rate limit Geno รอแล้วลองใหม่เอง | [เครือข่ายหลุดหรือชน rate limit แล้ว Geno รอ](/scenarios/err/offline-wait/) |

## Tool

| คำ | ความหมาย | ดูที่ |
| --- | --- | --- |
| **tool** | ความสามารถที่ Geno เปิดให้ model ขอใช้ เช่น อ่านไฟล์ (`read`) แก้ไฟล์ (`edit`) และรันคำสั่ง (`bash`) model รันเองไม่ได้ มันเขียนคำขอเป็น JSON แล้ว Geno เป็นคนรัน คล้าย endpoint ที่ model เป็น client และ Geno เป็น server | [Tool คือสัญญา](/foundations/tools-are-contracts/) |
| **tool call** (`tool_use`) | บล็อกในคำตอบของ model ที่ขอเรียก tool มี `id` `name` และ `input` | [Tool คือสัญญา](/foundations/tools-are-contracts/) |
| **`tool_result`** | บล็อกใน request ถัดไปที่ส่งผลของ tool กลับให้ model อ้าง `tool_use_id` ของคำขอ เหมือน response ที่จับคู่กับ request ด้วย id error ก็ส่งแบบนี้ โดยมี `is_error: true` | [ผลของ tool ส่งกลับอย่างไร](/foundations/tool-results/) |
| **`input_schema`** | JSON Schema ที่บอกว่า input ของ tool ต้องหน้าตาอย่างไร Geno ตรวจ input กับ schema นี้ก่อนรันทุกครั้ง | [Tool คือสัญญา](/foundations/tools-are-contracts/) |
| **executor** | ฟังก์ชันใน engine ของ tool แต่ละตัว ที่ตรวจ input แล้วรัน tool นั้นจริง | [Tool คือสัญญา](/foundations/tools-are-contracts/) |
| **tool batch** (ชุด) | tool call หลายตัวในคำตอบเดียว Geno รันตัวที่แค่อ่านพร้อมกัน และแยกตัวที่แก้ของออกเป็นชุดที่รันต่อกัน | [Geno แบ่ง tool call แบบผสมเป็นชุด](/scenarios/tool/mixed-batch-sequencing/) |
| **deferred tool** (`tool_search`) | tool ที่ Geno ไม่ส่ง schema ใน `tools` สำหรับ tool ของ Geno เอง ส่งแค่ชื่อกับประโยคแรกของคำอธิบายไว้ในคำอธิบายของ `tool_search` (และเลื่อนเฉพาะเมื่อประหยัดได้อย่างน้อย 300 token) model ต้องเรียก `tool_search` เพื่อโหลด schema ก่อนใช้ | [โหลด tool ที่เลื่อนไว้ด้วย tool_search](/scenarios/tool/deferred-tool-load/) |
| **MCP** (Model Context Protocol) | โปรโตคอลมาตรฐานที่โปรแกรมภายนอก (MCP server) ใช้เสนอ tool ให้ agent Geno ต่อกับ server เหล่านั้นแล้วส่ง tool ของมันให้ model เป็น deferred tool เสมอ แต่ชื่อไม่อยู่ในคำอธิบายของ `tool_search` Geno บอกชื่อในโน้ต `[Geno]` เมื่อ server ต่อติด แล้ว model โหลด schema ด้วย `tool_search` ก่อนใช้ | [เรียก tool ของ MCP](/scenarios/ext/mcp-tool-call/) |
| **skill** | ไฟล์ `SKILL.md` ที่สอนวิธีทำงานแบบหนึ่ง model เห็นแค่ชื่อกับคำอธิบายสั้นในข้อความแรก แล้วเรียก tool `skill` เพื่อโหลดเนื้อหาเต็มเมื่อต้องใช้ | [Model เรียก skill](/scenarios/ext/skill-by-model/) |
| **check** | คำสั่งตรวจของโปรเจกต์ที่คุณตั้งไว้ เช่น type checker linter หรือเทสต์ model เรียกผ่าน tool `check` และ `gcode agent` รันเองหลัง `edit` ที่สำเร็จเป็นค่าเริ่มต้น | [Agent loop](/foundations/agent-loop/) |
| **todo** | tool ที่ model ใช้เขียนรายการงานของตัวเอง แผงปักรายการนั้นไว้ให้คุณเห็นความคืบหน้า | [Model อัปเดตรายการ todo](/scenarios/tool/todo-list/) |
| **spill** | เมื่อผลของ tool ยาวเกิน 24,000 ตัวอักษร Geno เขียนผลเต็มลงไฟล์ แล้วส่งให้ model แค่ส่วนต้น ส่วนท้าย และ path ของไฟล์ | [ผลของ tool ยาวเกิน Geno เขียนลงไฟล์](/scenarios/ctx/large-output-spill/) |
| **คำสั่งเบื้องหลัง** (background) | คำสั่ง `bash` ที่รันต่อไปโดย turn ไม่รอให้จบ เช่น dev server model อ่าน output ทีหลังด้วย `bash_output` | [Model รันคำสั่งเบื้องหลัง](/scenarios/tool/bash-background/) |
| **monitor** | tool ที่เฝ้า output ของคำสั่งเบื้องหลัง แล้วปลุก session เมื่อเจอบรรทัดที่ตรง pattern เมื่อคำสั่งจบ หรือเมื่อหมดเวลา | [monitor จับ pattern แล้วปลุก](/scenarios/bg/monitor-wakes/) |
| **wake** (การปลุก) | เมื่องานเบื้องหลังรายงานกลับหลัง turn จบไปแล้ว engine เริ่ม turn ใหม่เองโดยไม่มีใครพิมพ์ ข้อความแรกของ turn นั้นบอกว่าทำไมถูกปลุก model ตั้งเวลาปลุกเองได้ด้วย `schedule_wakeup` | [คำสั่งเบื้องหลังจบแล้วปลุก](/scenarios/bg/command-ends-wakes/) |

## Loop และ session

| คำ | ความหมาย | ดูที่ |
| --- | --- | --- |
| **harness** | โปรแกรมรอบ model ที่ทำให้ model ทำงานเป็นเอเจนต์ได้ มันเก็บบทสนทนา รัน tool ขอสิทธิ์ และตัดสินว่าจะเรียก model อีกหรือไม่ ใน Geno คือ engine | [Model คือ API call หนึ่งครั้ง](/foundations/model-is-one-call/) |
| **agent** (เอเจนต์) | model ที่ทำงานหลายขั้นต่อกันได้เอง เพราะมี harness คอยรัน tool แล้วเรียก model ซ้ำพร้อมผล | [Agent loop](/foundations/agent-loop/) |
| **agent loop** (loop) | วงที่ harness ทำซ้ำ อ่าน log ตัดสินขั้นต่อไป เรียก model หรือรัน tool บันทึกผล แล้ววนอีกจนจบ turn | [Agent loop](/foundations/agent-loop/) |
| **turn** | ทุกอย่างที่เกิดตั้งแต่คุณส่ง prompt หนึ่งข้อจนคำตอบจบ turn หนึ่งอาจเรียก model หลายครั้งและรัน tool หลายตัว เหมือน request หนึ่งที่ server ทำงานเบื้องหลังหลายขั้นก่อนตอบ | [Agent loop](/foundations/agent-loop/) |
| **session** | บทสนทนาหนึ่งชุด หรือหนึ่งแชต มี id และ log ของตัวเอง เปิดต่อภายหลังได้ | [ส่วนประกอบของ Geno](/foundations/parts-of-geno/) |
| **session log** | ไฟล์ JSONL (JSON หนึ่งก้อนต่อบรรทัด) ใต้ `~/.g-code/sessions` ที่ engine ต่อท้าย event ทุกอย่างของ session และไม่แก้ของเก่า request ทุกก้อนสร้างจากไฟล์นี้ คล้าย event log แบบ append-only ของระบบ event sourcing | [Model คือ API call หนึ่งครั้ง](/foundations/model-is-one-call/) |
| **event** | หนึ่งบรรทัดใน session log เช่น `user` (prompt ของคุณ) `assistant` (คำตอบของ model) `tool-result` และ `notice` | [Agent loop](/foundations/agent-loop/) |
| **`loopStep`** | ฟังก์ชันที่อ่าน log แล้วตอบว่าขั้นต่อไปคืออะไร เรียก model รัน tool หรือจบ turn | [Agent loop](/foundations/agent-loop/) |
| **โน้ต `[Geno]`** | ข้อความที่ Geno แทรกในข้อความ user เพื่อบอก model ว่ามีอะไรเปลี่ยน เช่น โหมด memory หรือ MCP tool ขึ้นต้นด้วย `[Geno]` ข้อความจากไฟล์หรือเว็บปลอมเป็นโน้ตนี้ไม่ได้ | [Model รู้ได้อย่างไรว่าต้องทำอะไร](/foundations/how-the-model-knows/) |
| **งบ** (limits) | ขีดจำกัดต่อ turn ค่าเริ่มต้นคือเรียก model ได้ 40 ครั้ง และใช้เงินได้ $0.40 ที่ราคาของ qwen3.8-flash (Geno ปรับตามราคาของ model ที่ใช้) ถึงแล้ว turn จบ ตัวเลขดอลลาร์ทุกตัวในเอกสารนี้ เช่นงบของ subagent หรืองานตามเวลา ใช้หลักเดียวกัน | [ครบ 40 ครั้งหรือเกินงบ](/scenarios/mstop/limits/) |
| **Stop** | ปุ่มที่หยุด turn ที่กำลังทำงาน engine ยกเลิกการเรียก model และ tool ที่ค้างอยู่ | [กด Stop ขณะ model กำลังเขียน](/scenarios/ctl/stop-while-streaming/) |
| **steer** | ข้อความที่คุณพิมพ์ขณะ turn ยังทำงาน Geno ไม่ขัดกลาง stream แต่ส่งให้ model ใน request ถัดไป ต่อจากผลของ tool ชุดที่เพิ่งเสร็จ | [ส่งข้อความแทรก (steer)](/scenarios/ctl/steer-delivered/) |
| **compaction** | เมื่อบทสนทนายาวถึงเกณฑ์ Geno เรียก model อีกครั้งให้สรุปส่วนเก่า แล้วส่งสรุปแทนส่วนนั้น ข้อความล่าสุดที่คุณพิมพ์ (รวมไม่เกิน 40,000 ตัวอักษร และไม่เกิน 8,000 ตัวอักษรต่อข้อความ) ถูกเก็บคำต่อคำแยกจากสรุป ข้อความที่เก่ากว่านั้นไปอยู่ในสรุป | [Memory และ context window](/foundations/memory-and-context/) |
| **`recall`** | tool ที่ model ใช้ค้นส่วนของ session ที่ถูกสรุปไปแล้วแบบคำต่อคำ เช่น ข้อความ error ที่สรุปตัดไป และค้น session ก่อนหน้าของ workspace เดียวกันด้วย (เฉพาะสิ่งที่คุณพิมพ์ คำตอบ และชื่อ tool call ไม่รวม output ของ tool) | [Memory และ context window](/foundations/memory-and-context/) |
| **memory** | โน้ตสั้นที่ model ขอจดด้วย tool `remember` และคุณกดอนุมัติ Geno ใส่โน้ตเหล่านี้ในข้อความแรกของ session ต่อๆ ไป | [Model ขอจดจำ](/scenarios/ext/memory-write/) |
| **ไฟล์คำสั่ง** (`AGENTS.md` `CLAUDE.md`) | ไฟล์ที่คุณหรือ repo เขียนบอกวิธีทำงาน Geno โหลดตอนเปิด session แล้วใส่ในข้อความแรก | [โหลดคำสั่งโปรเจกต์ memory และ skill](/scenarios/start/new-session-context/) |
| **checkpoint** | ภาพถ่ายไฟล์ใน workspace ที่ Geno เก็บก่อนการเรียก model ทุกครั้ง ใน git repo ซ่อนที่อยู่นอกโฟลเดอร์ของคุณ turn ที่เรียก model สี่ครั้งจึงมีสี่อัน การย้อนไฟล์ (Rewind) ใช้อันแรกของ turn ที่คุณเลือก | [ย้อนไฟล์และ/หรือบทสนทนา](/scenarios/sess/rewind/) |
| **Rewind** | ย้อนไฟล์ บทสนทนา หรือทั้งสองอย่าง กลับไปก่อน turn ที่คุณเลือก | [ย้อนไฟล์และ/หรือบทสนทนา](/scenarios/sess/rewind/) |

## สิทธิ์และความปลอดภัย

| คำ | ความหมาย | ดูที่ |
| --- | --- | --- |
| **permission** (สิทธิ์) | การตัดสินว่า tool call หนึ่งรันได้เลย ต้องถามคุณก่อน หรือถูกปฏิเสธ Geno ตัดสินก่อนรันทุก call | [โหมด Ask ขอ permission ก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/) |
| **การ์ด permission** | การ์ดในแชตที่ถามว่าให้รันคำสั่งนี้ไหม engine รอคำตอบของคุณก่อนเดินต่อ | [โหมด Ask ขอ permission ก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/) |
| **กฎ** (permission rules) | รายการที่บอกว่าคำสั่ง path หรือ host แบบไหนอนุญาต ต้องถาม หรือปฏิเสธ มีทั้งกฎในตัว Geno และกฎที่คุณหรือ workspace ตั้ง | [กฎของ workspace อนุญาตหรือปฏิเสธคำสั่ง](/scenarios/perm/workspace-rules/) |
| **โหมด Ask** | โหมดเริ่มต้น Geno ถามคุณก่อนทุกคำสั่งที่กฎจับว่าเสี่ยง | [โหมด Ask ขอ permission](/scenarios/perm/ask-mode-bash-approval/) |
| **โหมด Auto** | Geno รันเองทั้งคำสั่งใน safe list คำสั่งใน sandbox ที่ติดธงแค่เพราะไม่อยู่ใน safe list และ `git push` ธรรมดาไป branch ของ repo ถามคุณก่อน `rm -rf` ของ workspace ทั้งก้อนหรือนอก workspace และให้ classifier ตัดสินที่เหลือที่กฎติดธง ถ้า classifier ไม่อนุญาต call ไม่รันและเหตุผลกลับไปหา model โดยไม่มีการ์ด การปฏิเสธแบบนี้เรียกว่า block เมื่อ block ติดกันครบ 3 ครั้งหรือรวมครบ 20 ครั้งใน session block ถัดไปจึงขึ้นการ์ดถามคุณแทน | [โหมด Auto ให้ classifier ตัดสินคำสั่ง](/scenarios/perm/auto-classifier/) |
| **โหมด Plan** | อ่านอย่างเดียว ไม่แก้ไฟล์ และรันเฉพาะคำสั่งในรายการที่ปลอดภัย model ยังเห็น tool ครบ แต่ Geno ปฏิเสธตอนรัน | [โหมด Plan ปฏิเสธคำสั่งและการแก้ไฟล์](/scenarios/perm/plan-refuses/) |
| **non-interactive** | การรันที่ไม่มีใครตอบการ์ด เช่น `gcode agent --non-interactive` ในสคริปต์หรือการทดสอบ สิ่งที่ปกติต้องถามจะถูกตัดสินทันทีว่าอนุญาตหรือปฏิเสธ | [รัน agent จากเทอร์มินัล](/scenarios/cli/agent-run/) |
| **safe list** | รายการคำสั่งที่ Geno ถือว่าไม่เสี่ยงและรันได้โดยไม่ถามในทุกโหมด (เว้นแต่กฎห้ามของ workspace ตรงกับคำสั่ง) เช่นโปรแกรมอ่านอย่างเดียว (`ls`, `grep`, `git status`) และคำสั่งตรวจของโปรเจกต์ (`tsc`, `vitest`, `pnpm test`) | [คำสั่งที่ปลอดภัยรันโดยไม่ถาม](/scenarios/tool/bash-safe-runs/) |
| **classifier** | การเรียก model แยกอีกครั้งในโหมด Auto ที่อ่าน call ที่กฎติดธงแล้วตอบว่า allow ask หรือ deny ผ่าน tool `verdict` มีแค่ allow ที่ทำให้ call รัน ask กับ deny ปฏิเสธ call และส่งเหตุผลกลับไปหา model | [โหมด Auto ให้ classifier ตัดสินคำสั่ง](/scenarios/perm/auto-classifier/) |
| **sandbox** | กรอบของระบบปฏิบัติการที่คำสั่ง `bash` รันอยู่ข้างใน เขียนไฟล์ได้แค่ใน workspace กับโฟลเดอร์ชั่วคราว และต่อเครือข่ายได้แค่ host ที่อนุญาต ถึงคุณกดอนุญาตคำสั่งแล้ว sandbox ก็ยังกัน ยกเว้นคำสั่งที่ขอรันนอก sandbox (`dangerouslyDisableSandbox`) แล้วคุณอนุญาต หรือ classifier อนุญาตในโหมด Auto | [Sandbox กันคำสั่งที่คุณอนุญาตแล้ว](/scenarios/sec/sandbox-blocks-write/) |
| **workspace** | โฟลเดอร์ที่คุณเปิดใน VS Code หรือที่คุณรัน `gcode` Geno อ่านและแก้ในนี้ได้ นอกนี้ต้องขอ | [Model อ่านไฟล์นอก workspace](/scenarios/perm/read-outside-workspace/) |
| **hook** | คำสั่ง shell ที่คุณตั้งให้ Geno รันเมื่อเกิดเหตุการณ์ใน loop เช่น ก่อนรัน tool (`PreToolUse`) หลังรัน (`PostToolUse`) ตอนต้องขอสิทธิ์ (`PermissionRequest`) หรือตอน model จะจบ turn (`Stop`) คล้าย webhook แต่เป็นคำสั่งในเครื่อง ผลของมันอนุญาต ปฏิเสธ หรือเพิ่มข้อความให้ model ได้ | [hook PreToolUse ตัดสิน call ก่อนรัน](/scenarios/hook/pretooluse-deny/) |
| **prompt injection** | ข้อความในไฟล์ หน้าเว็บ หรือ output ของคำสั่ง ที่พยายามสั่ง model Geno ส่งของเหล่านี้ให้ model เป็นข้อมูล ไม่ใช่คำสั่ง | [ไฟล์ใน repo สั่งให้ agent ส่งความลับออกไป](/practice/injection-in-contributing/) |

## ส่วนประกอบและการสื่อสาร

| คำ | ความหมาย | ดูที่ |
| --- | --- | --- |
| **Geno panel** (webview) | หน้าเว็บในแถบข้างของ VS Code ที่วาดแชต การ์ด และช่องพิมพ์ ไม่มีสิทธิ์อ่านไฟล์หรือต่อเครือข่าย | [ส่วนประกอบของ Geno](/foundations/parts-of-geno/) |
| **extension host** | process Node.js ที่ VS Code ใช้รันโค้ดของ extension ทุกตัว ส่วนของ Geno ในนี้ถือการเชื่อมต่อกับ engine และส่งสิ่งที่ต้องวาดให้แผง | [ส่วนประกอบของ Geno](/foundations/parts-of-geno/) |
| **postMessage** | วิธีที่ webview กับ extension host ส่งข้อความ JSON หากัน แบบเดียวกับ `window.postMessage` ในเบราว์เซอร์ | [จาก output สู่หน้าจอ](/foundations/output-to-screen/) |
| **engine** (`gcode serve`) | process แยกที่เดิน turn มี loop การตรวจสิทธิ์ การเรียก model และ session log อยู่ต่อแม้คุณ reload หน้าต่าง | [ส่วนประกอบของ Geno](/foundations/parts-of-geno/) |
| **`gcode agent`** (CLI) | คำสั่งในเทอร์มินัลที่รัน loop เดียวกันใน process เดียว ไม่มีแผงและไม่มี ACP ข้อความของ model ออกทางเทอร์มินัล | [รัน agent จากเทอร์มินัล](/scenarios/cli/agent-run/) |
| **Unix socket** | ช่องสื่อสารระหว่างสอง process ในเครื่องเดียวกัน ที่อยู่เป็น path ของไฟล์ เช่น `$TMPDIR/gcode-<hash>.sock` แทน host กับ port คล้ายต่อ TCP ไป localhost แต่ไม่ผ่านเครือข่าย | [ส่วนประกอบของ Geno](/foundations/parts-of-geno/) |
| **JSON-RPC** | รูปแบบข้อความที่แต่ละข้อความเป็น JSON มี `method` กับ `params` คำขอมี `id` และคำตอบอ้าง `id` เดิม ต่างจาก REST ตรงที่ทั้งสองฝั่งส่งคำขอหากันได้บนการเชื่อมต่อเดียว และมี notification ที่ไม่ต้องตอบ | [จาก output สู่หน้าจอ](/foundations/output-to-screen/) |
| **ACP** (Agent Client Protocol) | โปรโตคอลสาธารณะบน JSON-RPC ระหว่าง editor กับ agent engine เป็นฝั่ง agent extension เป็นฝั่ง client method หลักคือ `session/new` `session/prompt` `session/update` และ `session/request_permission` | [จาก output สู่หน้าจอ](/foundations/output-to-screen/) |
| **`_meta`** | field ใน ACP ที่ Geno ใส่ข้อมูลเพิ่มของตัวเอง (key `gcode/*`) editor อื่นที่ไม่รู้จักก็ข้ามไปได้ | [จาก output สู่หน้าจอ](/foundations/output-to-screen/) |

## Subagent และงานคู่ขนาน

| คำ | ความหมาย | ดูที่ |
| --- | --- | --- |
| **subagent** | session ลูกที่ model สร้างด้วย tool `agent` เพื่อทำงานย่อย มี system prompt และบทสนทนาของตัวเอง subagent ที่เริ่มจากหน้าว่างต้องจบด้วย tool `report` ที่ส่งรายงานสั้นกลับไปหาแม่ ส่วน fork ไม่มี `report` ข้อความสุดท้ายของมันคือรายงาน รายงานเป็นข้อมูล ไม่ใช่คำสั่ง | [สร้าง subagent แล้วรอรายงาน](/scenarios/sub/blocking-report/) |
| **fork** | มีสองความหมาย subagent ที่เริ่มด้วยบทสนทนาของแม่แทนหน้าว่าง หรือแชตใหม่ที่คัดลอกบทสนทนาเดิมถึง turn ที่เลือก | [fork subagent จากบทสนทนา](/scenarios/sub/fork/) |
| **worktree** และ **lane** | git worktree คือโฟลเดอร์ที่สองของ repo เดียวกันบน branch ของตัวเอง Geno เรียกแต่ละอันว่า lane ให้ subagent หรืองานแยกแก้ไฟล์โดยไม่ชนกับโฟลเดอร์หลัก แล้วนำกลับมาใช้ทีหลัง (lane นี้ไม่เกี่ยวกับมุมมอง Swim lane ของทัวร์) | [subagent ใน worktree แยก](/scenarios/sub/worktree-lane/) |
| **arena** | รันงานเดียวกันในหลาย lane พร้อมกัน แต่ละ lane ใช้ model effort คำสั่ง หรือ agent ภายนอกต่างกัน แล้ว subagent `review` จัดอันดับให้คุณเลือก | [Arena](/scenarios/wf/arena-best-of-n/) |
| **spinoff** | model เสนองานแยกที่อยู่นอกงานตอนนี้ด้วย tool `spawn_task` แผงขึ้นการ์ด แล้วคุณกดเริ่มใน lane ของมันเองหรือปิดทิ้ง | [เสนองานแยกแล้วเริ่ม](/scenarios/wf/spinoff/) |
| **workflow** | ไฟล์ JSON เล็กๆ ที่รัน subagent เป็นขั้นที่กำหนดไว้ล่วงหน้า เช่น review แล้ว fix แล้ว verify บางขั้นรัน subagent หลายตัวพร้อมกัน และบางขั้นเป็นการตรวจ (gate) ว่าจะไปต่อไหม คุณเห็นงบและยืนยันก่อนรัน run ที่ค้างทำต่อได้จาก journal | [รัน workflow พร้อมความคืบหน้า](/scenarios/wf/workflow-run/) |

## ใน editor

| คำ | ความหมาย | ดูที่ |
| --- | --- | --- |
| **diff** และ **hunk** | diff คือความต่างของไฟล์ก่อนกับหลังแก้ hunk คือก้อนบรรทัดที่เปลี่ยนติดกันหนึ่งก้อนใน diff คุณกด Keep หรือ Undo ทีละ hunk ได้ | [Keep หรือ Undo ทีละ hunk](/scenarios/ed/review-hunks/) |
| **Cmd-K** | แก้โค้ดที่เลือกใน editor ด้วยคำสั่งสั้นหนึ่งประโยค | [Cmd-K แก้โค้ดที่เลือก](/scenarios/ed/inline-edit-cmd-k/) |
| **Tab completion** | model เสนอโค้ดต่อจากเคอร์เซอร์ คุณกด Tab เพื่อรับ | [Tab เติมโค้ด](/scenarios/ed/tab-completion/) |
| **@mention** | พิมพ์ `@` ตามด้วยชื่อไฟล์หรือชื่อ subagent ใน prompt เพื่อแนบไฟล์หรือเรียก subagent ตัวนั้นตรงๆ | [แนบไฟล์และ @mention](/scenarios/start/attach-and-mention/) |
| **คำสั่ง `/`** (slash command) | คำสั่งที่ขึ้นต้นด้วย `/` บางตัว Geno ทำเอง เช่น `/compact` บางตัวเป็นแม่แบบที่กลายเป็น prompt | [คำสั่ง / ที่ Geno ทำเอง](/scenarios/ext/slash-builtin/) |

## คำของเอกสารนี้

| คำ | ความหมาย | ดูที่ |
| --- | --- | --- |
| **ทัวร์** และ **beat** | หน้าสถานการณ์ที่เล่าเรื่องทีละจังหวะ แต่ละจังหวะ (beat) คือช่วงที่ฝ่ายหนึ่งทำอะไรแล้วส่งต่อ | [วิธีอ่านทัวร์](/start/how-to-read/) |
| **การ์ดข้อมูล** | กล่อง JSON ที่คัดจากการรันจริง หรือจาก engine จริงกับ model จำลอง ตามที่หัวการ์ดบอก เช่น request ที่ส่งให้ model หรือ event ใน session log ส่วนที่ไฮไลต์คือสิ่งที่ควรดู ส่วนที่พับไว้คลิกเปิดได้ | [วิธีอ่านทัวร์](/start/how-to-read/) |
| **รายการ A06, A13, …** | งานทดสอบที่รัน Geno จริง ส่วนใหญ่กับ qwen3.8-flash (รอบ `sonnet-1` กับ Claude Sonnet 5.5) แล้วเก็บไฟล์ไว้ใต้ `docs/results/real-usecases/runs/` เลขรอบ เช่น `1` หรือ `fix-a2` คือการรันซ้ำแต่ละครั้ง | [Model คือ API call หนึ่งครั้ง](/foundations/model-is-one-call/) |
| **`session.jsonl` `requests.jsonl` `wire.jsonl`** | ไฟล์ที่เก็บไว้ในแต่ละรอบ ไม่มีรอบไหนมีครบสามแบบ รอบส่วนใหญ่มี `session.jsonl` รอบแรกๆ มี `requests.jsonl` รอบหลังมี `wire.jsonl` แทน `session.jsonl` คือ session log `requests.jsonl` คือ request ที่สร้างใหม่จาก log ตอนเก็บผล และ `wire.jsonl` (wire log) คือไบต์ที่ส่งไปและได้รับจริง | [Model คือ API call หนึ่งครั้ง](/foundations/model-is-one-call/) |
