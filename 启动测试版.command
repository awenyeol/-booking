#!/bin/bash
cd "$(dirname "$0")"
clear
echo "Starting RGSG IHS G11 Booking Internal Test..."
if command -v python3 >/dev/null 2>&1; then
  python3 server.py
else
  echo "未找到 Python 3。请先安装 Python 3，或在终端运行 python3 server.py。"
  read -p "Press Enter to close..."
fi
