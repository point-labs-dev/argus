#!/bin/bash
exec bash "$(cd "$(dirname "$0")" && pwd)/install-launchd.sh" "$@"
