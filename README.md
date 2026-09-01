# 🤖 DC Online 24/7

## การทำงาน

- เข้า Discord Voice Channel เมื่อเริ่มรัน
- เมื่อ Voice หลุด ระบบจะพยายามกู้ connection เดิมอัตโนมัติ
- หากกู้ไม่สำเร็จ ระบบจะรอและลองใหม่ด้วย backoff `15s → 30s → 60s → … → 5m`
- หน้า Dashboard แสดงสถานะ Voice, จำนวนครั้งที่กำลังกู้ connection และ uptime
- ไม่มีปุ่ม Rejoin; ระบบจัดการการเชื่อมต่ออัตโนมัติทั้งหมด

## วิธีใช้งาน

### 1. ตั้งค่า Environment Variables

คัดลอกไฟล์ตัวอย่างเป็น `.env` แล้วใส่ค่าของคุณ

```bash
cp .env.example .env
```

| ตัวแปร | รายละเอียด |
|---|---|
| `DISCORD_TOKEN` | Discord token |
| `GUILD_ID` | Discord Server (Guild) ID |
| `VOICE_CHANNEL_ID` | Voice Channel ID ที่ต้องการเข้า |
| `PORT` | Port สำหรับหน้าเว็บ (ค่าเริ่มต้น `3500`) |

### 2. รันบนเครื่อง

```bash
npm ci
npm start
```

จากนั้นเปิด `http://localhost:3500`

### 3. รันบน Render

สร้าง Web Service แล้วตั้งค่าดังนี้:

- Runtime: `Node`
- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/healthz`
- Instances: `1`

เพิ่ม Environment Variables ใน Render:

- `DISCORD_TOKEN`
- `GUILD_ID`
- `VOICE_CHANNEL_ID`

### Endpoints

| Endpoint | การใช้งาน |
|---|---|
| `/` | หน้า Dashboard |
| `/healthz` | Health check สำหรับ Render |
| `/voice-status` | ดูสถานะ Voice สำหรับ monitoring |
| `/ping` | เหมือน `/voice-status` |
