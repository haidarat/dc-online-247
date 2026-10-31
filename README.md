# DC Online 24/7

## การทำงาน

- ล็อกอิน Discord เมื่อเริ่มรัน
- ถ้าบัญชียังไม่ได้อยู่ห้อง `VOICE_CHANNEL_ID` ระบบจะสั่งเข้าห้องนั้น
- ระบบเฝ้า Voice state ของบัญชีตัวเองเท่านั้น
- หากถูกย้ายหรือออกจากห้องเป้าหมายจริง ระบบจะรอ 10 วินาที แล้วเข้ากลับ
- หาก Discord ยังรายงานว่าบัญชีอยู่ห้องเป้าหมาย ระบบจะไม่สั่ง rejoin ซ้ำ
- มี endpoint `/healthz` สำหรับ Render และ cron-job.org

## Deploy บน Render

1. Push โปรเจ็กต์ขึ้น GitHub แล้วเปิด [Render Dashboard](https://dashboard.render.com/)
2. เลือก **New** → **Web Service** และเชื่อมต่อ repository นี้
3. ตั้งค่าดังนี้

| ช่อง | ค่า |
|---|---|
| Runtime | `Node` |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Instances | `1` |

4. ใน **Environment Variables** ของ Render เพิ่มค่าเหล่านี้

| ตัวแปร | ค่า |
|---|---|
| `DISCORD_TOKEN` | Discord token ของบัญชีที่ใช้รัน |
| `GUILD_ID` | ID ของ Discord server |
| `VOICE_CHANNEL_ID` | ID ของห้อง Voice ที่ต้องการเข้า |

Render กำหนด `PORT` ให้เอง จึงไม่ต้องเพิ่ม `PORT` ในหน้า Render

5. กด Deploy แล้วเปิด URL ต่อท้ายด้วย `/healthz`

```text
https://YOUR-SERVICE.onrender.com/healthz
```

ถ้าพร้อมใช้งาน จะตอบกลับ:

```json
{"ok":true}
```

## ตั้ง cron-job.org

ใช้เฉพาะกรณีที่เลือก Render Free และต้องการให้ service ไม่ idle เกิน 15 นาที

1. สมัครหรือเข้าสู่ระบบที่ [cron-job.org](https://cron-job.org/)
2. สร้าง cron job ใหม่
3. ตั้งค่า URL เป็น

```text
https://YOUR-SERVICE.onrender.com/healthz
```

4. ตั้ง **Request Method** เป็น `GET`
5. ตั้ง **Execution schedule** เป็นทุก 10 นาที
6. เปิดใช้งาน job แล้วกด **Test run**
7. ตรวจ history ให้ได้ HTTP status `200`

`/healthz` ไม่แสดง token หรือข้อมูล Discord จึงใช้เป็น URL สำหรับ cron ได้โดยตรง

> Render Free จะพัก Web Service หลังไม่มี inbound traffic 15 นาที การเรียก `/healthz` ทุก 10 นาทีช่วยไม่ให้ idle ได้ แต่ Free service ยังอาจ restart ได้เอง หากต้องการ 24/7 ที่ต่อเนื่องจริงให้ใช้ Render แบบเสียเงิน
