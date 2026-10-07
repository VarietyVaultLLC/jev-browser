@echo off
rem Starts a second, visible Edge on its own profile with a debug port for jev-browser (JEV_BROWSER_CDP=http://127.0.0.1:9222).
rem Your everyday Edge keeps running untouched; this one keeps its logins in C:\EdgeDebug.
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir=C:\EdgeDebug --no-first-run
