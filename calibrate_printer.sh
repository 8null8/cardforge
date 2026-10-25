#!/usr/bin/env bash
# Prints a test page to measure how far your printer shifts the back side, then saves the correction.
exec python3 "$(dirname "$(readlink -f "$0")")/cardforge.py" --calibrate --open "$@"
