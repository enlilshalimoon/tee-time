# tee-time-bot

Monitors golf courses on **ForeUp**, **TeeSnap**, and **EZLinks/GolfNow** and sends a **Telegram message** when tee times matching your criteria open up.

---

## Setup (5 minutes)

### Step 1 — Install Node.js

If you don't have it: https://nodejs.org (pick the LTS version, works on Mac, Windows, Linux).

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Create a Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts → you'll get a **bot token** like `123456789:AABBcc...`
3. Start a chat with your new bot (search for its username and hit Start)
4. Get your **chat ID** — visit this URL in a browser (replace `TOKEN`):
   ```
   https://api.telegram.org/botTOKEN/getUpdates
   ```
   Send your bot any message first, then open that URL. Look for `"chat":{"id":` — that number is your chat ID.

### Step 4 — Configure credentials

```bash
cp .env.example .env
```

Edit `.env`:

```
TELEGRAM_BOT_TOKEN=123456789:AABBccDDeeFFggHHiiJJkkLLmmNNooP
TELEGRAM_CHAT_ID=987654321
CHECK_INTERVAL=*/5 * * * *   # every 5 minutes
DAYS_AHEAD=7
```

### Step 5 — Add your courses

```bash
cp config.example.json config.json
```

Edit `config.json` — see the **Course Configuration** section below.

### Step 6 — Run it

```bash
# Test a single check right now (great for verifying everything works)
npm run check

# Run continuously (checks on schedule, keeps running)
npm run dev
```

---

## Where to run it

| Option | Notes |
|--------|-------|
| **Your laptop / desktop** | Easiest. Just leave the terminal open or use a background process manager. |
| **Raspberry Pi** | Perfect — cheap, always-on, uses ~2W. |
| **VPS (DigitalOcean, Linode, Hetzner)** | $4–6/month, runs 24/7, no hardware needed. |
| **Free cloud (Railway, Render, Fly.io)** | Free tiers available, deploy from GitHub. |

### Keep it running with PM2 (Mac/Linux/Pi)

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name tee-time-bot
pm2 save
pm2 startup   # auto-start on reboot
```

### Keep it running as a Windows service

Use [NSSM](https://nssm.cc/) or just leave `npm run dev` running in a terminal.

---

## Course Configuration (`config.json`)

Each course needs `name`, `platform`, and platform-specific IDs.

### Finding your course IDs

Open the course's booking page, open **DevTools → Network tab** (F12), search for tee times, then look for the API request. Each platform's ID is in the URL or query parameters.

| Platform | Request to look for | ID to grab |
|----------|--------------------|-----------  |
| **ForeUp** | `foreupsoftware.com/index.php/api/booking/times` | `schedule_id` and `booking_class` in the query string |
| **TeeSnap** | `api.teesnap.net/v1/courses/{id}/teetimes` | the number in the path |
| **EZLinks** | `ezlinksgolf.com/api/` or `golfnow.com/` | `facilityId` in query params |

### All config options

```jsonc
{
  "courses": [
    {
      "name": "Pebble Beach",       // shown in Telegram messages
      "platform": "foreup",         // "foreup" | "teesnap" | "ezlinks"

      // ForeUp only
      "foreupScheduleId": "21",
      "foreupBookingClass": "1308",

      // TeeSnap only
      "tesnapCourseId": "12345",

      // EZLinks only
      "ezlinksFacilityId": "67890",
      "ezlinksBookingUrl": "https://...",  // optional, used as Referer

      // Filters — all optional
      "earliestTime": "07:00",      // ignore tee times before this (24h)
      "latestTime":   "11:00",      // ignore tee times after this (24h)
      "minPlayers": 2,              // minimum available spots required
      "daysOfWeek": [5, 6, 0]       // 0=Sun, 1=Mon … 6=Sat; omit = every day
    }
  ]
}
```

---

## Project layout

```
tee-time/
├── src/
│   ├── index.ts            # Entry point + cron scheduler
│   ├── checker.ts          # Loops over courses and dates
│   ├── notifier.ts         # Sends Telegram messages
│   ├── types.ts            # Shared TypeScript types
│   └── checkers/
│       ├── foreup.ts       # ForeUp Software API
│       ├── teesnap.ts      # TeeSnap API
│       └── ezlinks.ts      # EZLinks / GolfNow API
├── config.example.json     # Example course config
├── .env.example            # Example environment variables
├── package.json
└── tsconfig.json
```
