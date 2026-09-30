"""Regenerate the original app artwork: python -m pip install Pillow; python dev/build-icon.py."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SCALE = 4
SIZE = 256

# One incoming account, two routes, one illuminated destination.
svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<defs><linearGradient id="tile" x2="0" y2="1"><stop stop-color="#608ef2"/><stop offset="1" stop-color="#244dad"/></linearGradient></defs>
<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#tile)"/>
<rect x="9" y="9" width="238" height="238" rx="57" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="2"/>
<path d="M68 128h40q20 0 20 20v20q0 20 20 20h40" fill="none" stroke="#a8c5ff" stroke-opacity=".65" stroke-width="16" stroke-linecap="round"/>
<path d="M68 128h40q20 0 20-20V88q0-20 20-20h40" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round"/>
<circle cx="64" cy="128" r="20" fill="#fff"/>
<circle cx="192" cy="68" r="20" fill="#fff"/>
<circle cx="192" cy="188" r="16" fill="#244dad" stroke="#b3ceff" stroke-width="8"/>
</svg>'''
(ROOT / 'dashboard/mark.svg').write_text(svg, encoding='utf-8')

image = Image.new('RGBA', (SIZE*SCALE, SIZE*SCALE))
draw = ImageDraw.Draw(image)
top, bottom = (96, 142, 242), (36, 77, 173)
for y in range(SIZE*SCALE):
    t = min(1, max(0, (y/SCALE-8)/240))
    color = tuple(round(a+(b-a)*t) for a, b in zip(top, bottom))
    draw.line((0, y, SIZE*SCALE, y), fill=(*color, 255))
mask = Image.new('L', image.size)
ImageDraw.Draw(mask).rounded_rectangle(tuple(v*SCALE for v in (8, 8, 248, 248)), 58*SCALE, fill=255)
image.putalpha(mask)
overlay = Image.new('RGBA', image.size)
ImageDraw.Draw(overlay).rounded_rectangle(tuple(v*SCALE for v in (9, 9, 247, 247)), 57*SCALE, outline=(255,255,255,51), width=2*SCALE)
image = Image.alpha_composite(image, overlay)
draw = ImageDraw.Draw(image)

def curve(start, control, end):
    return [((1-t)**2*start[0]+2*(1-t)*t*control[0]+t*t*end[0],
             (1-t)**2*start[1]+2*(1-t)*t*control[1]+t*t*end[1]) for t in [i/32 for i in range(33)]]

def route(down, color):
    mid, bend, target = (148,168,188) if down else (108,88,68)
    points = [(68,128),(108,128)] + curve((108,128),(128,128),(128,mid))
    points += [(128,bend)] + curve((128,bend),(128,target),(148,target)) + [(192,target)]
    draw.line([(round(x*SCALE),round(y*SCALE)) for x,y in points], fill=color, width=16*SCALE, joint="curve")
    for x, y in points:
        draw.ellipse(tuple(round(v*SCALE) for v in (x-8,y-8,x+8,y+8)), fill=color)

route(True, '#89aaf0')
route(False, '#ffffff')
for x,y,r,fill in [(64,128,20,'#ffffff'),(192,68,20,'#ffffff'),(192,188,20,'#b3ceff'),(192,188,12,'#244dad')]:
    draw.ellipse(tuple(v*SCALE for v in (x-r,y-r,x+r,y+r)), fill=fill)
image.resize((512,512), Image.Resampling.LANCZOS).save(ROOT / 'desktop/icon.png')
image.resize((32,32), Image.Resampling.LANCZOS).save(ROOT / 'desktop/tray.png')
image.save(ROOT / 'desktop/icon.ico', sizes=[(n,n) for n in (16,20,24,32,40,48,64,96,128,256)])
