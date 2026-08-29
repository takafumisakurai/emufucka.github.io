#!/bin/sh
set -eu

tag='//assets.adobedtm.com/launch-EN55cd23628bbd44698a353b23d0bac718.min.js'
pages='
index.html
profile/index.html
photos/index.html
highlights/index.html
press/index.html
video/index.html
audio/index.html
discography/index.html
live/index.html
'

for page in $pages; do
  if ! grep -Fq "$tag" "$page"; then
    printf '%s\n' "Missing Adobe Launch/AEP Tags script in $page" >&2
    exit 1
  fi
done

printf '%s\n' "Adobe Launch/AEP Tags script is present in site pages."
