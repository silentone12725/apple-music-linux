#!/usr/bin/env python3
"""Generate the MSIX package logos from the app icon (electron/icon.png) into electron/msix-assets/.

electron-builder falls back to its own generic icon for any logo it is not given, so the package ships a full
set: every scale of the required logos plus the unplated target sizes Windows uses for the taskbar, Alt+Tab,
the Start list and Settings -> Default apps. Run it after changing the app icon and commit the result.

Needs Pillow:  python3 scripts/make-msix-assets.py
"""
from pathlib import Path
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / 'electron' / 'icon.png'
OUT = REPO / 'electron' / 'msix-assets'

SCALES = (100, 125, 150, 200, 400)
icon = Image.open(SRC).convert('RGBA')


def render(w, h, fill=1.0):
    """The icon, scaled to `fill` of the shorter side and centred on a transparent w x h canvas."""
    side = max(1, round(min(w, h) * fill))
    art = icon.resize((side, side), Image.LANCZOS)
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    canvas.paste(art, ((w - side) // 2, (h - side) // 2), art)
    return canvas


def save(name, w, h, fill=1.0):
    render(w, h, fill).save(OUT / name, optimize=True)


OUT.mkdir(parents=True, exist_ok=True)
for old in OUT.glob('*.png'):
    old.unlink()

# name -> (base width, base height, how much of the short side the icon fills)
SCALED = {
    'StoreLogo': (50, 50, 1.0),
    'Square44x44Logo': (44, 44, 1.0),
    'Square150x150Logo': (150, 150, 0.8),
    'SmallTile': (71, 71, 0.8),
    'LargeTile': (310, 310, 0.8),
    'Wide310x150Logo': (310, 150, 0.8),
    'SplashScreen': (620, 300, 0.5),
}
for name, (w, h, fill) in SCALED.items():
    for s in SCALES:
        save(f'{name}.scale-{s}.png', round(w * s / 100), round(h * s / 100), fill)

# Taskbar, Alt+Tab, Start list, Default apps: exact pixel sizes, plated and unplated.
for t in (16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256):
    save(f'Square44x44Logo.targetsize-{t}.png', t, t)
    save(f'Square44x44Logo.targetsize-{t}_altform-unplated.png', t, t)

print(f'{len(list(OUT.glob("*.png")))} logos written to {OUT.relative_to(REPO)}')
