# 🤖 DC Online 24/7

Discord Voice connection พร้อมหน้าเว็บสถานะ **read-only** สำหรับนำไปรันบน Render

> ⚠️ โปรเจกต์นี้ใช้ user token/selfbot ซึ่ง Discord ระบุว่าห้ามทำ automation กับบัญชีผู้ใช้ และอาจทำให้บัญชีถูกปิดได้ ควรใช้ bot account อย่างเป็นทางการหากงานของคุณรองรับ

## สิ่งที่โปรเจกต์ทำ

- 🔊 เข้า Voice Channel เมื่อเริ่มระบบ
- 🔄 กู้ Voice connection เดิมก่อน; จะสร้าง connection ใหม่เฉพาะเมื่อกู้เดิมไม่สำเร็จหลายครั้ง
- 🕒 ใช้ backoff `15s → 30s → 60s → … → 5m` และจะรีเซ็ตเมื่อ `Ready` ต่อเนื่อง 1 นาที
- 🛑 เมื่อถูกนำออกจากห้อง จะรอ 5 นาทีก่อนพยายามกู้ เพื่อไม่ให้เกิด leave/join loop
- 📊 แสดงหน้า Dashboard แบบ read-only โดยไม่เผยชื่อบัญชี, Guild, หรือ Voice Channel
- 🩺 แยก health check ของ Render ออกจากสถานะ Voice เพื่อไม่ให้ Voice หลุดชั่วคราวแล้ว Render restart service

ไม่มีปุ่ม Rejoin หรือ endpoint ควบคุมจากหน้าเว็บ จึงไม่มีช่องให้เดารหัสหรือสั่ง connection จากภายนอก

## Environment Variables

สร้าง `.env` สำหรับเครื่องของคุณจาก `.env.example` แล้วเติมค่าจริง ห้าม commit ไฟล์นี้

| ตัวแปร | จำเป็น | รายละเอียด |
|---|:---:|---|
| `DISCORD_TOKEN` | ✅ | Discord credential — เก็บเฉพาะใน `.env` หรือ Render Environment |
| `GUILD_ID` | ✅ | Discord Guild ID |
| `VOICE_CHANNEL_ID` | ✅ | Voice Channel ID ที่ต้องการเข้า |
| `PORT` | ❌ | local default คือ `3500`; บน Render ใช้ค่าที่ Render ให้มา |

โค้ดยังอ่านข้อความตัวพิมพ์เล็กชุดเดิม (`token`, `server`, `id`) เพื่อย้ายระบบเดิมได้โดยไม่ดับ แต่การตั้งค่าใหม่ควรใช้ชื่อด้านบน

## Deploy บน Render

1. เปิด secret scanning และ push protection ใน GitHub ก่อนเปิด repository เป็น public
2. สร้าง **Web Service** จาก branch production ของ repository
3. ตั้งค่า:

   - Runtime: `Node`
   - Build Command: `npm ci`
   - Start Command: `npm start`
   - Instances: `1` เท่านั้น — หลาย instance จะใช้ Discord credential เดียวกันและอาจสร้าง Voice connection ซ้ำ
   - Health Check Path: `/healthz`

4. ในหน้า **Environment** ของ Render เพิ่ม `DISCORD_TOKEN`, `GUILD_ID`, และ `VOICE_CHANNEL_ID` ด้วยค่าจริง อย่าใส่ secrets ลง GitHub หรือ `render.yaml`
5. ใช้ Node 22 ตาม `package.json`; Node 18 หมดระยะการสนับสนุนด้านความปลอดภัยแล้ว

### สำคัญ: Health Check และ Monitoring

| Endpoint | ใช้สำหรับ | HTTP เมื่อ Voice หลุด |
|---|---|:---:|
| `/healthz` | Render Health Check เท่านั้น | `200` |
| `/voice-status` | UptimeRobot / external monitor เพื่อแจ้งเตือน | `503` |
| `/ping` | alias เดิมของ `/voice-status` | `503` |
| `/api/stats` | ข้อมูล read-only สำหรับหน้า Dashboard | `200` |

**ห้าม** ตั้ง Render Health Check เป็น `/ping` หรือ `/voice-status` เพราะ status `503` แปลว่า Voice หลุด—not that the Node process is unhealthy. หาก Render restart service จากเหตุนี้ จะเกิดการ join ใหม่และเพิ่ม `Service-Initiated` โดยไม่จำเป็น

external monitor สามารถเรียก `/voice-status` ทุก 5 นาทีเพื่อรับการแจ้งเตือนได้; endpoint นี้ไม่มีคำสั่งควบคุมใด ๆ

## แนวทางลด Service-Initiated

- Push/deploy ใหม่จะ restart process และต้อง join Voice ใหม่อย่างน้อยหนึ่งครั้ง: deploy เฉพาะเมื่อพร้อม และใช้ branch production ที่ผ่านการทดสอบแล้ว
- อย่าเปิด autoscaling หรือมากกว่า 1 instance
- ปล่อยให้ระบบ backoff ทำงาน; อย่า restart service ซ้ำระหว่างที่ Dashboard แสดง `RECONNECTING`
- หากถูกนำออกจาก Voice ซ้ำ ๆ ให้ตรวจ permission/Discord server setting ก่อน แทนการบังคับ rejoin ถี่ ๆ

## ความปลอดภัยสำหรับ Public GitHub

- `.env`, `.env.*`, private keys และ service-account files ถูก ignore แล้ว
- อย่าส่ง token ใน issue, log, screenshot, deployment variable, หรือ commit เก่า
- หาก token เคยถูก push—even if later deleted—ให้ revoke/rotate ทันที
- เปิด MFA สำหรับบัญชี GitHub และ Render
- เปิด Dependency updates/Dependabot และตรวจ `npm audit` ก่อน deploy

## Local run

```bash
cp .env.example .env
npm ci
npm start
```

เปิด Dashboard ที่ `http://localhost:3500` แล้วตรวจว่า `/healthz` ตอบ `200`
