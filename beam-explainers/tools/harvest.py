#!/usr/bin/env python3
"""Download the real Heritage Timber and Timberthane product images from the Ekena/FauxBeams
CDN: every texture x finish product shot, the finish and texture swatches, the extra product
angles, and the inspiration-gallery room photos. Writes img/assets.json with the source URL of
every file so each image in a video can be traced back to the store listing it came from.

    python -I tools/harvest.py <beams dir>
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
SITE = "https://www.fauxbeams.com"
CDN = "https://cdn.synergycdn.com/images"
FINISH_ATTR, TEXTURE_ATTR = 1838, 1837

ROOT = Path(sys.argv[1]).resolve()
IMG = ROOT / "img"
assets: dict[str, dict] = {}


def get(url: str, referer: str = SITE + "/") -> bytes:
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (404, 302, 301):
                raise
            time.sleep(2 ** attempt)
        except Exception:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed: {url}")


def get_json(url: str):
    return json.loads(get(url).decode("utf-8"))


def slug(s: str) -> str:
    return "".join(c.lower() if c.isalnum() else "-" for c in s).strip("-").replace("--", "-")


def save(rel: str, urls: list[str], meta: dict) -> bool:
    """Save the first URL that answers with an image; record where it came from."""
    out = IMG / rel
    if out.is_file() and out.stat().st_size > 2000:
        assets[rel] = {**meta, "source": assets.get(rel, {}).get("source") or urls[0]}
        return True
    for u in urls:
        try:
            data = get(u)
        except Exception:
            continue
        if data[:3] != b"\xff\xd8\xff" and data[:8] != b"\x89PNG\r\n\x1a\n":
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        assets[rel] = {**meta, "source": u}
        return True
    print("  MISSING", rel, urls[0])
    return False


def zoom_urls(image_id: str) -> list[str]:
    return [f"{CDN}/id/zoom/{image_id}.jpg", f"{CDN}/id/0600/{image_id}.jpg"]


def swatch_urls(url_0118: str) -> list[str]:
    return [url_0118.replace("/0118/", "/0600/"), url_0118.replace("/0118/", "/0255/"), url_0118]


def option_images(child_sku: str, attr: int):
    q = urllib.parse.urlencode({"childSku": child_sku, "attributeId": attr})
    return get_json(f"https://www.synergycdn.com/content/variant/get_variant_option_images.php?&{q}")


def flat(sku: str):
    q = urllib.parse.urlencode({"sku": sku, "related": "true", "multidomain_id": 8, "store_id": 1})
    return get_json(f"{SITE}/php/product/get_flat_data.php?{q}")


jobs: list[tuple[str, list[str], dict]] = []

# ---- Heritage Timber (Quick Ship U-beams) -------------------------------------------------------
# One 4x4x8' child per texture, then every finish of that texture.
HERITAGE_TEXTURE_SKUS = {
    "Mena": "BMMAS3C00400X0400X96KB",
    "Reclaimed Axed Cut": "BMRDS3C00400X0400X96KB",
    "Resawn Rip": "BMRRS3C00400X0400X96KB",
    "Rustic Sawn": "BMRSS3C00400X0400X96KB",
    "Salvaged Timber": "BMSTS3C00400X0400X96KB",
    "Sanded Smooth": "BMSSS3C00400X0400X96OT",
}
for tex in option_images("BMSTS3C00400X0400X96KB", TEXTURE_ATTR):
    jobs.append((f"heritage/swatch/texture-{slug(tex['optionName'])}.jpg", swatch_urls(tex["swatchURL"]),
                 {"line": "heritage", "kind": "texture-swatch", "texture": tex["optionName"], "sku": tex["sku"]}))
for tex_name, sku in HERITAGE_TEXTURE_SKUS.items():
    for fin in option_images(sku, FINISH_ATTR):
        meta = {"line": "heritage", "kind": "product", "texture": tex_name, "finish": fin["optionName"],
                "sku": fin["sku"], "listing": f"{SITE}/Ekena-Millwork-Beams-{fin['sku']}"}
        jobs.append((f"heritage/product/{slug(tex_name)}/{slug(fin['optionName'])}.jpg",
                     zoom_urls(fin["internalIdOfImage"]), meta))
        if tex_name == "Salvaged Timber":
            jobs.append((f"heritage/swatch/finish-{slug(fin['optionName'])}.jpg", swatch_urls(fin["swatchURL"]),
                         {"line": "heritage", "kind": "finish-swatch", "finish": fin["optionName"], "sku": fin["sku"]}))
# Extra angles + room photos from the listing.
hf = flat("BMSTS3C00400X0400X96KB")
for name in hf["images"]["product"]:
    jobs.append((f"heritage/angles/{name}", [f"{CDN}/id/zoom/{name}", f"{CDN}/id/0600/{name}"],
                 {"line": "heritage", "kind": "angle", "sku": "BMSTS3C00400X0400X96KB"}))
for g in hf["images"].get("gallery") or []:
    jobs.append((f"heritage/rooms/{g['name']}", [f"{CDN}/customer_projects/zoom/{g['name']}"],
                 {"line": "heritage", "kind": "room", "alt": g.get("alt_text") or "", "sku": "BMSTS3"}))
# Endcap and sample.
jobs.append(("heritage/accessories/endcap.jpg", zoom_urls("2165632"), {"line": "heritage", "kind": "endcap", "sku": "BMC_P"}))
jobs.append(("heritage/accessories/sample-kit.jpg", zoom_urls("SAMPLE-KIT-BMRSS3KB"), {"line": "heritage", "kind": "sample", "sku": "BM-HT-SAMPLE"}))

# ---- Timberthane (made to order) ----------------------------------------------------------------
TT_TEXTURE_CODES = {"Hand Hewn": "HH", "Knotty Pine": "KP", "Pecky Cypress": "PC", "Riverwood": "RW",
                    "Rough Cedar": "RC", "Rough Sawn": "RS", "Rustic Smooth": "SM", "Sandblasted": "SD"}
for tex_name, code in TT_TEXTURE_CODES.items():
    child = f"BM{code}3C0060X060X096UN" if code == "SM" else f"BM{code}3C0060X060X096ZD"
    try:
        fins = option_images(child, FINISH_ATTR)
    except Exception as e:  # noqa: BLE001
        print("  no finishes for", tex_name, e)
        fins = []
    for fin in fins:
        meta = {"line": "timberthane", "kind": "product", "texture": tex_name, "finish": fin["optionName"],
                "sku": fin["sku"], "listing": f"{SITE}/Ekena-Millwork-Beams-BM{code}3-ST"}
        jobs.append((f"timberthane/product/{slug(tex_name)}/{slug(fin['optionName'])}.jpg",
                     zoom_urls(fin["internalIdOfImage"]), meta))
        if tex_name == "Hand Hewn":
            jobs.append((f"timberthane/swatch/finish-{slug(fin['optionName'])}.jpg", swatch_urls(fin["swatchURL"]),
                         {"line": "timberthane", "kind": "finish-swatch", "finish": fin["optionName"], "sku": fin["sku"]}))
    # The four shapes in Aged (plank, L, U, box).
    for s, shape in (("1", "plank"), ("2", "l-beam"), ("3", "u-beam"), ("4", "box-beam")):
        jobs.append((f"timberthane/shapes/{slug(tex_name)}-{shape}.jpg", zoom_urls(f"BM{code}S{s}C0ZD") + zoom_urls(f"BM{code}S{s}C0UN"),
                     {"line": "timberthane", "kind": "shape", "texture": tex_name, "shape": shape}))
# Builder swatches: all 29 finishes and 8 textures, including the three only the builder offers.
builder = get_json(f"{SITE}/php/product/get_variant_builder_data.php?sku=BM")
for f in builder["fields"].values():
    label = f["label"].strip()
    if label not in ("Finish", "Texture"):
        continue
    for o in f["options"].values():
        u = o.get("swatchURL")
        if not u:
            continue
        cands = [u.replace("/0050/", "/0600/"), u.replace("/0050/", "/0255/"), u.replace("/0050/", "/0118/"), u]
        jobs.append((f"timberthane/builder/{label.lower()}-{slug(o['name'])}.jpg", cands,
                     {"line": "timberthane", "kind": f"builder-{label.lower()}-swatch", "name": o["name"], "code": o.get("code")}))
tf = flat("BMHH3C0040X040X096ZD")
for name in tf["images"]["product"]:
    jobs.append((f"timberthane/angles/{name}", [f"{CDN}/id/zoom/{name}", f"{CDN}/id/0600/{name}"],
                 {"line": "timberthane", "kind": "angle", "sku": "BMHH3C0040X040X096ZD"}))
for g in tf["images"].get("gallery") or []:
    jobs.append((f"timberthane/rooms/{g['name']}", [f"{CDN}/customer_projects/zoom/{g['name']}"],
                 {"line": "timberthane", "kind": "room", "alt": g.get("alt_text") or "", "sku": "BMHH3-ST"}))
jobs.append(("timberthane/accessories/material-sample.jpg", zoom_urls("2109321"), {"line": "timberthane", "kind": "sample", "sku": "BM-MAT-SAMPLE"}))

print(f"{len(jobs)} images to fetch")
with ThreadPoolExecutor(8) as ex:
    ok = list(ex.map(lambda j: save(*j), jobs))
print(f"saved {sum(ok)}/{len(jobs)}")
(IMG / "assets.json").write_text(json.dumps(dict(sorted(assets.items())), indent=1), encoding="utf-8")
