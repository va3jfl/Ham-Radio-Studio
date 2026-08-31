#!/usr/bin/env python3
"""Feed the browser-rendered pressing to the UNMODIFIED desktop VREC decoder.
Run run_postcard_tests.js first (it writes the PNG + expected json), then:
    python3 cross_compat.py [path-to-VREC-Studio]
"""
import sys, json, hashlib, os
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else
                os.path.expanduser("~/VREC-Studio-main"))
from vinyl_codec import decode_record

here = os.path.dirname(os.path.abspath(__file__))
audio, rate, hdr, codes = decode_record(os.path.join(here, "postcard_crosscompat.png"))
exp = json.load(open(os.path.join(here, "postcard_crosscompat.json")))
ok = (rate == exp["rate"] and hdr["n_samples"] == exp["n"] and
      hashlib.sha256(codes.tobytes()).hexdigest() == exp["codes_sha"])
print(f"desktop decode: {rate} Hz, {hdr['n_samples']} samples, "
      f"pitch {hdr['pitch']} step {hdr['step']}")
print("CROSS-COMPAT PASS" if ok else "CROSS-COMPAT FAIL")
sys.exit(0 if ok else 1)
