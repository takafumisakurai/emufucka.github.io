#!/bin/sh
set -eu

tag='//assets.adobedtm.com/launch-EN55cd23628bbd44698a353b23d0bac718.min.js'

if ! grep -Fq "$tag" index.html; then
  printf '%s\n' "Missing Adobe Launch/AEP Tags script in index.html" >&2
  exit 1
fi

printf '%s\n' "Adobe Launch/AEP Tags script is present."
