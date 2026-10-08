import sys, glob
from PIL import Image, ImageDraw, ImageFont
out, cols, cell = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
files = sys.argv[4:]
rows = (len(files) + cols - 1) // cols
W = cols * cell; H = rows * (cell + 22)
im = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(im)
try: font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
except Exception: font = None
for i, f in enumerate(files):
    t = Image.open(f).convert("RGB"); t.thumbnail((cell, cell))
    x = (i % cols) * cell; y = (i // cols) * (cell + 22)
    im.paste(t, (x + (cell - t.width)//2, y + (cell - t.height)//2))
    lab = "/".join(f.split("/")[-2:]).replace(".jpg", "")
    d.text((x + 4, y + cell + 3), lab[:40], fill="black", font=font)
im.save(out, quality=85)
print(out, im.size)
