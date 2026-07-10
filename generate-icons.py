#!/usr/bin/env python3
"""
Run this script once to generate the app icons:
  python3 generate-icons.py

Requires: pip install Pillow
"""

from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs('icons', exist_ok=True)

def make_icon(size, path):
    img = Image.new('RGB', (size, size), color='#030712')
    draw = ImageDraw.Draw(img)

    # Background circle gradient effect (solid for simplicity)
    margin = size // 8
    draw.ellipse(
        [margin, margin, size - margin, size - margin],
        fill='#06B6D4',  # cyan-500
    )

    # Inner circle
    inner_m = margin + size // 10
    draw.ellipse(
        [inner_m, inner_m, size - inner_m, size - inner_m],
        fill='#030712',
    )

    # Emoji-style runner text (fallback if no emoji font)
    try:
        font_size = size // 3
        font = ImageFont.truetype('/System/Library/Fonts/Apple Color Emoji.ttc', font_size)
    except Exception:
        font = ImageFont.load_default()

    text = '🏃'
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x = (size - tw) // 2 - bbox[0]
        y = (size - th) // 2 - bbox[1]
        draw.text((x, y), text, font=font, embedded_color=True)
    except Exception:
        # Fallback: draw a simple "F" letter
        draw.text((size * 0.3, size * 0.25), 'F', fill='#22D3EE', font=font)

    img.save(path, 'PNG')
    print(f'  ✓ {path} ({size}×{size})')

print('Generating icons...')
make_icon(192, 'icons/icon-192.png')
make_icon(512, 'icons/icon-512.png')
make_icon(180, 'icons/icon.png')   # Apple touch icon
print('Done! Icons are in the /icons directory.')
