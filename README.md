# 🤖 DC Online 24/7

Discord Selfbot ช่วยให้ออนไลน์และอยู่ในห้องเสียง (Voice Channel) ตลอด 24 ชั่วโมง พร้อมหน้าเว็บ **Real-time Dashboard** (สไตล์ Hyper-Glassmorphism Dark) และระบบ **Health Check Monitor**

---

## ✨ คุณสมบัติหลัก

- 🔊 **Auto-Join**: เข้าห้องเสียงทันทีเมื่อเริ่มรัน
- 🔄 **Auto-Reconnect**: ต่อกลับอัตโนมัติเมื่อหลุด (Exponential Backoff 3s → 60s)
- 🌐 **Web Dashboard**: ดูสถิติ Real-time อัปเดตทุก 1 วินาที (CPU, RAM, Uptime, ชื่อเซิร์ฟเวอร์/ห้อง)
- 🟢🔴 **Status Badge**: แสดงไฟสถานะ ONLINE / OFFLINE เด่นชัด
- 📡 **Health Monitor (`/ping`)**: ตอบ `200` เมื่ออยู่ในห้อง / `503` เมื่อหลุด (ใช้แจ้งเตือนผ่าน UptimeRobot)
- 🧠 **Low RAM**: ปิด Cache ที่ไม่จำเป็นเพื่อใช้ทรัพยากรน้อยที่สุด

---

## ⚙️ Environment Variables (ตั้งค่าในระบบ)

| ตัวแปร | จำเป็น | รายละเอียด |
|---|:---:|---|
| `token` | ✅ | Discord User Token (ไม่ใช่ Bot Token) |
| `server` | ✅ | Server ID (Guild ID) |
| `id` | ✅ | Voice Channel ID |
| `PORT` | ❌ | Port สำหรับ Web Dashboard (Default: `3500`) |

---

## 🚀 วิธีตั้งค่ารันบน Render.com (ฟรี 24/7)

### ขั้นตอนที่ 1: เตรียม Repository
1. Fork หรือ Clone repository นี้ไปยัง GitHub ของคุณ

### ขั้นตอนที่ 2: สร้าง Web Service บน Render
1. ไปที่ [Render Dashboard](https://dashboard.render.com/) Log in ให้เรียบร้อย
2. กดปุ่ม **New +** ➔ เลือก **Web Service**
3. เลือกเชื่อมต่อกับ Repository `dc-online-247` บน GitHub ของคุณ

### ขั้นตอนที่ 3: ตั้งค่าการ Deploy
กรอกข้อมูลในหน้าตั้งค่าดังนี้:
- **Name**: `dc-online-247` (หรือชื่อตามต้องการ)
- **Runtime**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `node --expose-gc index.js`

### ขั้นตอนที่ 4: ใส่ Environment Variables
1. เลื่อนลงมาที่หัวข้อ **Environment Variables**
2. เพิ่มตัวแปรตามนี้:
   - `token` = *[Discord User Token ของคุณ]*
   - `server` = *[Server ID]*
   - `id` = *[Voice Channel ID]*
3. กดปุ่ม **Create Web Service** และรอระบบ Deploy จนขึ้น `Live` 🟢

---

## 🔔 วิธีตั้งค่าแจ้งเตือนและกันดับ (cron-job.org)

เพื่อป้องกันไม่ให้ Render ปิดตัวเองและรับแจ้งเตือนเมื่อหลุด แนะนำให้ใช้บริการฟรีของ **[cron-job.org](https://cron-job.org)**:

1. สมัครและเข้าสู่ระบบที่ **[cron-job.org](https://cron-job.org)**
2. ไปที่เมนู **Cronjobs** ➔ กดปุ่ม **Create cronjob**
3. ตั้งค่าข้อมูลดังนี้:
   - **Title**: `DC Online 24/7 Ping`
   - **Address**: `https://<ชื่อแอปของคุณ>.onrender.com/ping` *(ใส่ `/ping` ต่อท้าย)*
   - **Execution schedule**: เลือกยิงทุกๆ `1 minute` หรือ `5 minutes`
4. กด **Create** เป็นอันเสร็จเรียบร้อย!

> 💡 **หมายเหตุ**: เมื่อบอทหลุดจากห้อง ระบบจะตอบกลับด้วย HTTP Code `503` และ cron-job.org จะแจ้งเตือนสถานะความผิดปกติให้ทราบทันที

---

## ⚠️ คำเตือน
> การใช้ Selfbot (User Token) ถือว่าผิดกฎ [Discord Terms of Service](https://discord.com/terms) โปรดใช้ด้วยความระมัดระวังและยอมรับความเสี่ยงด้วยตนเอง
