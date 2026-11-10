#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Stop the isolated renewal_kreview instance (ports 3101/3102). Leaves MariaDB and the store running.
for p in 3101 3102; do pid=$(lsof -tiTCP:$p -sTCP:LISTEN); [ -n "$pid" ] && kill $pid && echo "stopped :$p"; done
