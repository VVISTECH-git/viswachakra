@echo off
REM Hourly incremental sync for the Viswachakra scraper.
REM Runs headless, pulls cases changed in the last 2 hours, exits.
REM Registered with Windows Task Scheduler to run every hour.

cd /d "C:\Users\bhanu\Downloads\viswachakra"
set HEADLESS=true
node scraper.js --hours 2 --headless >> "logs\hourly-sync.log" 2>&1
