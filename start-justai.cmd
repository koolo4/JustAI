@echo off
rem Start JustAI: Ollama, server, web UI and browser. Double-click this file.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-justai.ps1"
