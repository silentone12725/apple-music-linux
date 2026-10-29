#!/bin/sh
# Build libadam_curl_capture.so next to this script. It has no link-time dependency on libhybris-core.so: it resolves
# the hybris entry points from the engine process at load time and stays inert everywhere else.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
gcc -shared -fPIC -O1 -Wall -o "$here/libadam_curl_capture.so" "$here/adam_curl_capture.c" -ldl -lpthread
echo "built $here/libadam_curl_capture.so"
