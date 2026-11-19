#!/usr/bin/env python3
"""
provision_linux.py — Linux-native ADI provisioning for apple-music-linux

No emulator needed. Uses Apple's MID provisioning endpoints directly.
The gsa.apple.com/grandslam/MidService/ endpoints do not require anisette headers.

Flow:
  1. POST startMachineProvisioning (empty plist) → SPIM
  2. stage9 provision mode: ADIProvisioningStart(SPIM) → CPIM + session (in-process)
  3. POST finishMachineProvisioning(CPIM) → PTM + TK
  4. stage9 provision mode: ADIProvisioningEnd(session, PTM, TK) → adi.pb written

Requirements:
  - stage9_prov_native binary compiled in same directory
  - 6.5.2 lib64 at ../../drm/rootfs-6.5.2/system/lib64

Usage:
  python3 provision_linux.py [--prov-dir ../../drm/files] [--android-id <hex16>]
"""

import os
import sys
import ssl
import subprocess
import base64
import uuid
import re
import argparse
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

SCRIPT_DIR = Path(__file__).parent
PROV_STAGE9 = SCRIPT_DIR / "stage9_prov_native"

# User-Agent from akd (Apple Key Distribution daemon) — required for MID endpoints
AKD_UA = "akd/1.0 CFNetwork/1404.0.5 Darwin/22.3.0"

# MID provisioning endpoints (confirmed from gsa.apple.com/grandslam/GsService2/lookup URL bag)
START_PROV_URL  = "https://gsa.apple.com/grandslam/MidService/startMachineProvisioning"
FINISH_PROV_URL = "https://gsa.apple.com/grandslam/MidService/finishMachineProvisioning"

# Client identity — these headers are required for the MID endpoints to respond
DEVICE_ID    = str(uuid.uuid4()).upper()   # X-Mme-Device-Id
LOCAL_UUID   = str(uuid.uuid4()).upper()   # X-Apple-I-MD-LU
CLIENT_INFO  = "<MacBookPro18,3> <Mac OS X;12.6;21G115> <com.apple.akd/1 (com.apple.akd/1.0)>"

# Apple uses a self-signed CA; skip verification
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

def run(cmd, **kwargs):
    """Run a command, return (stdout, stderr, rc)."""
    r = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    return r.stdout, r.stderr, r.returncode


EMPTY_PLIST = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    '<plist version="1.0"><dict>'
    '<key>Header</key><dict/>'
    '<key>Request</key><dict/>'
    '</dict></plist>'
)


def mid_request(url, body_str):
    """POST to a MID provisioning endpoint. No anisette headers needed."""
    headers = {
        "User-Agent": AKD_UA,
        "Content-Type": "application/x-apple-plist",
        "X-Mme-Device-Id": DEVICE_ID,
        "X-MMe-Client-Info": CLIENT_INFO,
        "X-Apple-I-MD-LU": LOCAL_UUID,
        "X-Apple-Client-App-Name": "Setup",
    }
    body = body_str.encode("utf-8")
    req = Request(url, data=body, headers=headers, method="POST")
    print(f"  POST {url}")
    try:
        with urlopen(req, context=SSL_CTX, timeout=30) as resp:
            response_body = resp.read()
            print(f"  Response: {resp.status} ({len(response_body)} bytes)")
            return response_body
    except HTTPError as e:
        body_err = e.read()
        print(f"  HTTP Error {e.code}: {body_err[:200]}")
        raise
    except URLError as e:
        print(f"  URL Error: {e.reason}")
        raise


def parse_spim_from_plist(plist_bytes):
    """Extract spim from Apple plist response."""
    # Simple regex extraction - no plistlib needed
    text = plist_bytes.decode("utf-8", errors="replace")

    # Look for <key>spim</key><data>BASE64DATA</data>
    m = re.search(r'<key>spim</key>\s*<data>\s*(.*?)\s*</data>', text, re.DOTALL)
    if m:
        return m.group(1).replace("\n", "").replace(" ", "")

    # Also try string format
    m = re.search(r'<key>spim</key>\s*<string>\s*(.*?)\s*</string>', text, re.DOTALL)
    if m:
        return m.group(1).replace("\n", "").replace(" ", "")

    print(f"  Response body: {text[:500]}")
    return None


def parse_ptm_tk_from_plist(plist_bytes):
    """Extract ptm and tk from Apple plist response."""
    text = plist_bytes.decode("utf-8", errors="replace")

    ptm = tk = None
    for key, varname in [("ptm", "ptm"), ("tk", "tk")]:
        m = re.search(rf'<key>{key}</key>\s*<data>\s*(.*?)\s*</data>', text, re.DOTALL)
        if m:
            if varname == "ptm":
                ptm = m.group(1).replace("\n", "").replace(" ", "")
            else:
                tk = m.group(1).replace("\n", "").replace(" ", "")
        else:
            m = re.search(rf'<key>{key}</key>\s*<string>\s*(.*?)\s*</string>', text, re.DOTALL)
            if m:
                if varname == "ptm":
                    ptm = m.group(1).replace("\n", "").replace(" ", "")
                else:
                    tk = m.group(1).replace("\n", "").replace(" ", "")

    if not ptm or not tk:
        print(f"  Response body: {text[:800]}")

    return ptm, tk


def stage9_start(prov_dir, android_id, spim_b64):
    """Call stage9 start to get CPIM + session_id."""
    stdout, stderr, rc = run([
        str(PROV_STAGE9), "start",
        str(prov_dir), android_id, spim_b64
    ])
    print(f"  stage9 start stderr: {stderr.strip()}")
    if rc != 0:
        print(f"  stage9 start FAILED (rc={rc})")
        return None, None

    cpim_b64 = session_id = None
    for line in stdout.splitlines():
        if line.startswith("CPIM_B64="):
            cpim_b64 = line[9:]
        elif line.startswith("SESSION_ID="):
            session_id = line[11:]

    return cpim_b64, session_id


def stage9_finish(prov_dir, android_id, session_id, ptm_b64, tk_b64):
    """Call stage9 finish to complete provisioning."""
    stdout, stderr, rc = run([
        str(PROV_STAGE9), "finish",
        str(prov_dir), android_id, session_id, ptm_b64, tk_b64
    ])
    print(f"  stage9 finish stderr: {stderr.strip()}")
    if rc != 0:
        print(f"  stage9 finish FAILED (rc={rc})")
        return False

    return "PROVISIONED=1" in stdout


def stage9_otp(prov_dir, android_id):
    """Generate OTP from Linux-provisioned adi.pb."""
    stdout, stderr, rc = run([
        str(PROV_STAGE9), "otp",
        str(prov_dir), android_id
    ])
    print(f"  stage9 otp stderr: {stderr.strip()}")
    if rc != 0:
        return None, None

    otp = mdm = None
    for line in stdout.splitlines():
        if line.startswith("OTP_B64="):
            otp = line[8:]
        elif line.startswith("MDM_B64="):
            mdm = line[8:]

    return otp, mdm


def provision(prov_dir, android_id, device_serial=None):
    """Full provisioning flow — no emulator dependency."""
    prov_dir = Path(prov_dir)

    print(f"\n{'='*60}")
    print(f"Linux-Native ADI Provisioning (emulator-free)")
    print(f"{'='*60}")
    print(f"prov_dir:   {prov_dir}")
    print(f"android_id: {android_id}")
    print(f"{'='*60}\n")

    # Backup existing adi.pb
    adi_path = prov_dir / "adi.pb"
    if adi_path.exists():
        import shutil
        backup = prov_dir / "adi.pb.bak"
        shutil.copy2(adi_path, backup)
        print(f"Backed up existing adi.pb to {backup}")
        adi_path.unlink()

    # Step 1: startMachineProvisioning → SPIM
    print("\n[1/3] startMachineProvisioning → SPIM...")
    spim_b64 = None
    try:
        resp = mid_request(START_PROV_URL, EMPTY_PLIST)
        spim_b64 = parse_spim_from_plist(resp)
        if spim_b64:
            print(f"  SPIM received: {spim_b64[:40]}... ({len(base64.b64decode(spim_b64))} bytes)")
    except Exception as e:
        print(f"  Failed: {e}")

    if not spim_b64:
        print("  FAILED: Could not get SPIM")
        return False

    # Step 2: stage9 'provision' mode — start+finish in ONE process so the
    # in-process session handle stays valid across both ADI calls.
    print("\n[2/3] ADI provisioning (single process: start → finish)...")
    proc = subprocess.Popen(
        [str(PROV_STAGE9), "provision", str(prov_dir), android_id],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True,
    )

    # Feed SPIM, read CPIM
    proc.stdin.write(f"SPIM_B64={spim_b64}\n")
    proc.stdin.flush()

    cpim_line = proc.stdout.readline().strip()
    if not cpim_line.startswith("CPIM_B64="):
        out, err = proc.communicate()
        print(f"  stage9 stderr: {proc.stderr.read() if not err else err}")
        print(f"  Unexpected output: {cpim_line!r}")
        return False
    cpim_b64 = cpim_line[9:]
    print(f"  CPIM: {cpim_b64[:40]}... ({len(base64.b64decode(cpim_b64))} bytes)")

    # Step 3: finishMachineProvisioning(CPIM) → PTM + TK
    print("\n[3/3] finishMachineProvisioning(CPIM) → PTM + TK...")
    # cpim must be a <string> (base64), not <data> — matches Dadoum/Provision D source
    finish_body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        '<plist version="1.0"><dict>'
        '\t<key>Header</key>\n\t<dict/>\n'
        '\t<key>Request</key>\n\t<dict>\n'
        '\t\t<key>cpim</key>\n\t\t<string>' + cpim_b64 + '</string>\n'
        '\t</dict>\n'
        '</dict></plist>'
    )

    ptm_b64 = tk_b64 = None
    try:
        resp = mid_request(FINISH_PROV_URL, finish_body)
        ptm_b64, tk_b64 = parse_ptm_tk_from_plist(resp)
        if ptm_b64 and tk_b64:
            print(f"  PTM: {ptm_b64[:40]}... ({len(base64.b64decode(ptm_b64))} bytes)")
            print(f"  TK:  {tk_b64[:40]}... ({len(base64.b64decode(tk_b64))} bytes)")
    except Exception as e:
        print(f"  Failed: {e}")
        proc.stdin.close()
        proc.wait()
        return False

    if not ptm_b64 or not tk_b64:
        print("  FAILED: Could not get PTM/TK")
        proc.stdin.close()
        proc.wait()
        return False

    # Feed PTM + TK back to stage9 (same process, session still live)
    proc.stdin.write(f"PTM_B64={ptm_b64}\n")
    proc.stdin.write(f"TK_B64={tk_b64}\n")
    proc.stdin.flush()
    proc.stdin.close()

    out, err = proc.communicate(timeout=30)
    print(f"  stage9 stderr: {err.strip()}")
    print(f"  stage9 stdout: {out.strip()}")

    if proc.returncode != 0 or "PROVISIONED=1" not in out:
        print("  FAILED: ADIProvisioningEnd failed")
        return False

    # Verify adi.pb was created
    if not adi_path.exists():
        print(f"  ERROR: adi.pb not created at {adi_path}")
        return False

    print(f"  adi.pb created: {adi_path.stat().st_size} bytes")

    # Test: generate OTP from new adi.pb
    print("\n[VERIFY] Testing OTP generation from new Linux adi.pb...")
    otp, mdm = stage9_otp(prov_dir, android_id)
    if otp and mdm:
        print(f"  SUCCESS!")
        print(f"  X-Apple-I-MD:   {otp}")
        print(f"  X-Apple-I-MD-M: {mdm}")

        # Save to files
        (prov_dir / "otp_md.b64").write_text(otp + "\n")
        (prov_dir / "otp_mdm.b64").write_text(mdm + "\n")
        print(f"\n  Saved to {prov_dir}/otp_md.b64 and otp_mdm.b64")
    else:
        print("  OTP generation failed — adi.pb may need re-verification")

    print(f"\n{'='*60}")
    print("PROVISIONING COMPLETE")
    print(f"Linux-native adi.pb: {adi_path}")
    print(f"Android ID used: {android_id}")
    print("This adi.pb will work without the Android emulator.")
    print(f"{'='*60}\n")
    return True


def main():
    parser = argparse.ArgumentParser(description="Linux-native ADI provisioning")
    parser.add_argument("--prov-dir", default="../../drm/files",
                        help="Path to provisioning dir (contains adi.pb)")
    parser.add_argument("--android-id", default=None,
                        help="16-char hex Android ID (default: read from ANDROID_ID file)")
    parser.add_argument("--device", default=None,
                        help="(ignored, kept for compatibility)")
    args = parser.parse_args()

    prov_dir = Path(args.prov_dir)

    # Read android_id
    android_id = args.android_id
    if not android_id:
        aid_file = prov_dir / "ANDROID_ID"
        if aid_file.exists():
            android_id = aid_file.read_text().strip()[:16]
        else:
            # Generate a fresh one
            android_id = os.urandom(8).hex()
            aid_file.write_text(android_id)
            print(f"Generated new Android ID: {android_id}")

    if len(android_id) != 16:
        print(f"ERROR: Android ID must be 16 hex chars, got: {android_id!r}")
        sys.exit(1)

    if not PROV_STAGE9.exists():
        print(f"ERROR: stage9_prov_native not found at {PROV_STAGE9}")
        print("Build it with: gcc -O2 stage9_prov_native.c ../../drm/embedded_blobs/embedded_loader.o ../../drm/embedded_blobs/libhybris-core.so.o -I../../drm -ldl -lpthread -o stage9_prov_native")
        sys.exit(1)

    success = provision(prov_dir, android_id, args.device)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
