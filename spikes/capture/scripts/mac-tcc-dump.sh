#!/usr/bin/env sh
# Optional evidence for the permission tests: show what TCC stored for the spike.
# Screen Recording lives in the *system* TCC database, which needs Full Disk
# Access for the terminal running this (System Settings > Privacy & Security >
# Full Disk Access > Terminal). Read-only.
set -eu
db="/Library/Application Support/com.apple.TCC/TCC.db"
id="${1:-dev.glimpse.spike.capture}"
sqlite3 "$db" "select client, client_type, auth_value, auth_reason, datetime(last_modified,'unixepoch','localtime'), hex(csreq) from access where service='kTCCServiceScreenCapture' and client like '%${id}%';" |
	while IFS='|' read -r client type value reason modified csreq; do
		echo "client=$client type=$type auth_value=$value (0 denied, 2 allowed) reason=$reason modified=$modified"
		if [ -n "$csreq" ]; then
			echo "$csreq" | xxd -r -p >/tmp/glim15-csreq.bin
			printf 'stored requirement: '
			csreq -r- -t </tmp/glim15-csreq.bin || echo "(could not decode)"
		else
			echo "stored requirement: (none: path-based)"
		fi
	done
