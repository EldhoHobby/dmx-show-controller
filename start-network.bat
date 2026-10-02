@echo off
rem DMX Show Controller with phone and tablet access.
rem Double-click, then open the "Phones and tablets ... can open" address on a phone that is on
rem the same Wi-Fi. Anyone on that network can control the lights, so use a network you trust.
call "%~dp0start.bat" --host 0.0.0.0
