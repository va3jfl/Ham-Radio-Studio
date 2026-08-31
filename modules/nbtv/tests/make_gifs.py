#!/usr/bin/env python3
"""Generate GIF fixtures + expected composited frames for the NBTV decoder test."""
import json, os, struct
from PIL import Image

OUT = os.path.dirname(os.path.abspath(__file__))

def dump_expected(name, frames_rgb, delays):
    exp = {
        "w": frames_rgb[0].width, "h": frames_rgb[0].height,
        "delays": delays,
        "frames": [list(f.convert("RGB").tobytes()) for f in frames_rgb],
    }
    with open(os.path.join(OUT, name + ".expected.json"), "w") as f:
        json.dump(exp, f)

# ---- fixture 1: solid-colour frames, distinct delays --------------------
frames = []
for col in [(255, 0, 0), (0, 255, 0), (0, 0, 255)]:
    frames.append(Image.new("RGB", (10, 8), col))
frames[0].save(os.path.join(OUT, "solid.gif"), save_all=True,
               append_images=frames[1:], duration=[300, 500, 700], loop=0,
               optimize=False)
dump_expected("solid", frames, [300, 500, 700])

# ---- fixture 2: partial-frame deltas (optimize on) ----------------------
import random
random.seed(7)
W, H = 24, 16
base = Image.new("RGB", (W, H))
px = base.load()
pal16 = [(i * 17 % 256, (i * 53) % 256, (i * 97) % 256) for i in range(16)]
for y in range(H):
    for x in range(W):
        px[x, y] = pal16[random.randrange(16)]
seq = [base]
cur = base
for k in range(4):
    nxt = cur.copy()
    p2 = nxt.load()
    # scribble a moving block so PIL emits partial frames
    for y in range(4 + k, 10 + k):
        for x in range(3 + 2 * k, 9 + 2 * k):
            p2[x % W, y % H] = pal16[(k * 3 + x + y) % 16]
    seq.append(nxt)
    cur = nxt
seq[0].save(os.path.join(OUT, "delta.gif"), save_all=True,
            append_images=seq[1:], duration=120, loop=0, optimize=True)
dump_expected("delta", seq, [120] * len(seq))

# ---- fixture 3: disposal=2 (restore to background) + transparency -------
# full red -> green box with disposal 2 -> blue box.  Browsers composite
# disposal-2 as "clear the box to transparent before the next frame";
# our decoder paints onto black later, but the *composited* RGBA is what
# we compare, so build expectations by hand.
f1 = Image.new("RGBA", (12, 10), (255, 0, 0, 255))
f2 = f1.copy(); f2.paste((0, 255, 0, 255), (2, 2, 7, 7))
f3 = f2.copy()
# after showing f2, its box (whole frame region PIL writes) may be cleared;
# PIL with disposal=2 writes SOME region cleared -> expectation depends on
# encoder details, so keep fixture 3 as a decode-must-not-crash + frame
# count + first-frame-exact test only.
f3.paste((0, 0, 255, 255), (6, 1, 11, 6))
f1.save(os.path.join(OUT, "dispose.gif"), save_all=True,
        append_images=[f2, f3], duration=100, loop=0, disposal=2,
        optimize=False)
with open(os.path.join(OUT, "dispose.expected.json"), "w") as f:
    json.dump({"w": 12, "h": 10, "nframes": 3,
               "frame0": list(f1.convert("RGB").tobytes())}, f)

# ---- fixture 4: hand-written INTERLACED gif ------------------------------
# 8x8, 256-colour greyscale palette, pixel value = y*8+x, interlace flag on.
def lzw_encode(indices, min_code=8):
    clear, eoi = 1 << min_code, (1 << min_code) + 1
    out, acc, bits = bytearray(), 0, 0
    size = min_code + 1
    nxt = eoi + 1

    def emit(code, csize):
        nonlocal acc, bits
        acc |= code << bits
        bits += csize
        while bits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            bits -= 8

    emit(clear, size)
    for v in indices:                    # every pixel as a root code
        emit(v, size)
        nxt += 1                         # decoder adds one entry per code
        if nxt == (1 << size) - 1:       # keep 9-bit: clear before growth
            emit(clear, size)
            nxt = eoi + 1
    emit(eoi, size)
    if bits:
        out.append(acc & 0xFF)
    return bytes(out)

W4, H4 = 8, 8
pix = [[(y * 8 + x) * 4 % 256 for x in range(W4)] for y in range(H4)]
# interlace storage row order for h=8: pass1 y=0; pass2 y=4; pass3 y=2,6; pass4 y=1,3,5,7
order = [0, 4, 2, 6, 1, 3, 5, 7]
stored = []
for y in order:
    stored.extend(pix[y])
gif = bytearray()
gif += b"GIF89a"
gif += struct.pack("<HH", W4, H4)
gif += bytes([0xF7, 0, 0])               # GCT, 256 colours
for i in range(256):
    gif += bytes([i, i, i])              # greyscale palette
gif += bytes([0x2C]) + struct.pack("<HHHH", 0, 0, W4, H4) + bytes([0x40])  # interlaced
gif += bytes([8])                        # LZW min code size
data = lzw_encode(stored)
for i in range(0, len(data), 255):
    chunk = data[i:i + 255]
    gif += bytes([len(chunk)]) + chunk
gif += bytes([0, 0x3B])
with open(os.path.join(OUT, "interlace.gif"), "wb") as f:
    f.write(bytes(gif))
with open(os.path.join(OUT, "interlace.expected.json"), "w") as f:
    json.dump({"w": W4, "h": H4,
               "grey": [v for row in pix for v in row]}, f)

# sanity: PIL must agree with our hand-built interlaced file
im = Image.open(os.path.join(OUT, "interlace.gif")).convert("L")
got = list(im.tobytes())
want = [v for row in pix for v in row]
assert got == want, "hand-built interlaced GIF wrong (PIL disagrees)"
print("fixtures written, PIL cross-check of interlace.gif OK")
