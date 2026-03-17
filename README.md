# tee-time-bot

A Node.js bot that monitors golf courses on **ForeUp**, **TeeSnap**, and **EZLinks/GolfNow** booking platforms and sends you an **email** when tee times matching your criteria become available.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` with your email credentials (see below) and preferred settings.

### 3. Configure your courses

```bash
cp config.example.json config.json
```

Edit `config.json` — add one entry per course. See the **Course Configuration** section below.

### 4. Run

```bash
# Development (runs immediately, then on schedule)
npm run dev

# Production (compile first)
npm run build
npm start

# Single check (useful for testing)
npm run check
```

---

## Email Setup

The bot uses **Nodemailer** to send emails via SMTP. Gmail is recommended.

### Gmail App Password (recommended)

1. Go to [myaccount.google.com/security](https://myaccount.google.com/security)
2. Enable **2-Step Verification** if not already enabled
3. Search for **"App passwords"** and create one for "Mail"
4. Use your Gmail address as `EMAIL_USER` and the 16-character app password as `EMAIL_PASS`

### `.env` settings

```
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=you@gmail.com
EMAIL_PASS=xxxx xxxx xxxx xxxx   # app password
EMAIL_FROM=you@gmail.com
EMAIL_TO=you@gmail.com           # can be a different address

CHECK_INTERVAL=*/5 * * * *       # cron: every 5 minutes
DAYS_AHEAD=7                     # how many days to look ahead
```

---

## Course Configuration (`config.json`)

Each course entry requires `name` and `platform`, plus platform-specific IDs.

### Finding your course IDs

Open your course's booking page in a browser, open **DevTools → Network tab**, then search for tee times. Look for the relevant API request and grab the IDs from the URL or query parameters.

| Platform | What to look for |
|----------|-----------------|
| **ForeUp** | Request to `foreupsoftware.com/index.php/api/booking/times` — grab `schedule_id` and `booking_class` from the query string |
| **TeeSnap** | Request to `api.teesnap.net/v1/courses/{courseId}/teetimes` — grab the number in the path |
| **EZLinks** | Request to `ezlinksgolf.com/api/` or `golfnow.com/` — grab `facilityId` from params |

### Config fields

```jsonc
{
  "name": "My Course",          // display name (used in email alerts)
  "platform": "foreup",         // "foreup" | "teesnap" | "ezlinks"

  // ForeUp
  "foreupScheduleId": "21",
  "foreupBookingClass": "1308",

  // TeeSnap
  "tesnapCourseId": "12345",

  // EZLinks / GolfNow
  "ezlinksFacilityId": "67890",
  "ezlinksBookingUrl": "https://...",   // optional, used as Referer

  // Filters (all optional)
  "earliestTime": "07:00",      // 24-hour HH:MM — ignore earlier slots
  "latestTime":   "11:00",      // 24-hour HH:MM — ignore later slots
  "minPlayers": 2,              // minimum available player spots
  "daysOfWeek": [5, 6, 0]       // 0=Sun … 6=Sat; omit to check every day
}
```

---

## Running as a service

### systemd (Linux)

Create `/etc/systemd/system/tee-time-bot.service`:

```ini
[Unit]
Description=Golf Tee Time Monitor Bot
After=network.target

[Service]
WorkingDirectory=/path/to/tee-time
ExecStart=/usr/bin/node /path/to/tee-time/dist/index.js
Restart=always
EnvironmentFile=/path/to/tee-time/.env
User=youruser

[Install]
WantedBy=multi-user.target
```

Then:

```bash
npm run build
sudo systemctl enable --now tee-time-bot
```

### PM2

```bash
npm run build
pm2 start dist/index.js --name tee-time-bot
pm2 save
```

---

## Project Structure

```
tee-time/
├── src/
│   ├── index.ts          # Entry point + scheduler
│   ├── checker.ts        # Orchestrates all course checks
│   ├── notifier.ts       # Email notifications
│   ├── types.ts          # Shared TypeScript types
│   └── checkers/
│       ├── foreup.ts     # ForeUp Software API
│       ├── teesnap.ts    # TeeSnap API
│       └── ezlinks.ts    # EZLinks / GolfNow API
├── config.example.json   # Example course configuration
├── .env.example          # Example environment variables
├── package.json
└── tsconfig.json
```
