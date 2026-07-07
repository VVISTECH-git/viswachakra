# Deploying the Viswachakra scraper on the Hyderabad desktop

This guide sets up the scraper on a fresh Windows machine and runs the full
historical backfill (which also pushes everything to Supabase).

## 1. Prerequisites (install once)

- **Node.js** (LTS) — https://nodejs.org  → run the installer, accept defaults
- **Google Chrome** — the scraper drives a real Chrome window
- **Git** — https://git-scm.com/download/win

Verify in a new Command Prompt:
```
node --version
git --version
```

## 2. Get the code

```
cd %USERPROFILE%\Downloads
git clone https://github.com/VVISTECH-git/viswachakra.git
cd viswachakra
npm install
```

## 3. Create the .env file

Create a file named `.env` in the `viswachakra` folder with these 6 lines
(copy the values from the laptop's `.env` — they are NOT in the repo):

```
LOGIN_URL=https://app.drntrvaidyaseva.ap.gov.in/ASRI/
VAIDYA_USERNAME=medco1_vcoh_mtm
VAIDYA_PASSWORD=<the portal password>
SUPABASE_URL=https://hhshbogxymuscjtpwgpm.supabase.co
SUPABASE_SERVICE_KEY=<the sb_secret_... key>
```

## 4. Run the full historical backfill

Pick a start date = roughly when the hospital's first case was registered.
The command scrapes in 2-day chunks (the portal times out on wide ranges),
then pushes everything to Supabase automatically.

```
node backfill.js --start "01/01/2024 00:00"
```

- Change `--start` to go further back or forward. Format: `DD/MM/YYYY HH:MM`.
- This is a LONG job (roughly 20-30 seconds per case). A year of cases can take
  several hours. Leave it running; a visible Chrome window will click through cases.
- Do NOT run any other scraper/login at the same time (the portal allows one
  session per account and rate-limits repeated logins).
- If it stops partway, just run it again with the same `--start` — already-scraped
  cases are updated, not duplicated.

When it finishes it prints `Backfill complete` and then pushes to Supabase.

## 5. After the backfill: schedule the hourly incremental sync

Once the history is loaded, set the ongoing job so the data stays fresh.
`run-hourly-sync.bat` runs a headless 2-hour-window sync and pushes to Supabase.

Register it with Task Scheduler (run in an **admin** Command Prompt):
```
schtasks /create /tn "Viswachakra Sync" /tr "%USERPROFILE%\Downloads\viswachakra\run-hourly-sync.bat" /sc hourly /rl highest /f
```

To see run history: open **Task Scheduler** → find "Viswachakra Sync" →
Last Run Time / Last Run Result. Full logs are in `logs\hourly-sync.log`.

## Notes

- The machine must be **on and online** for scheduled syncs to run.
- The scraper only works from an **Indian IP** (this desktop qualifies).
- To update the code later: `git pull` then `npm install`.
