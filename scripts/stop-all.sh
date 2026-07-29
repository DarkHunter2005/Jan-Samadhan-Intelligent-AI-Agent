#!/usr/bin/env bash
# Stops the ML service, backend and React dev server.
for port in 8000 4000 5173; do
  pids=$(ss -lptnH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
  if [ -n "$pids" ]; then kill $pids 2>/dev/null && echo "stopped port $port"; fi
done
