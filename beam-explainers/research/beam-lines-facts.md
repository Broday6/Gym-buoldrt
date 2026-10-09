# Heritage Timber vs Timberthane: product facts

Retrieved 8 Oct 2026 from FauxBeams.com (Ekena Millwork's own store). Every number below comes from
the store's product data, not from memory. The data comes from the listing pages, their variant data
(which sizes, textures and finishes can actually be ordered), the product records, and the FAQ on
the Quick Ship page. Sources are at the bottom; `facts.json` holds the same data for the video code.

## The short answer

| | **Heritage Timber** (Quick Ship) | **Timberthane** (Made to Order) |
|---|---|---|
| How it's made | **Molded as one piece** from real weathered timbers, so there are **no corner seams** | **Made to your size** from 1″-thick polyurethane sheets |
| Ships | Stained: **usually 3–5 business days**. Primed: usually 24–72 hours. (FAQ: "typically 3–7 business days") | **Usually 10–12 business days** |
| Shapes | 3-sided U-beam (plus Heritage round log beams and mantels) | **1-sided plank, 2-sided L-beam, 3-sided U-beam, 4-sided box beam** |
| Sizes | **8 cross-sections**: 3½×3½, 3½×5½, 5½×5½, 5½×7½, 7½×7½, 7½×9½, 9½×9½, 9½×11½ in | **Any size from 3″ to 24″** wide and high, in ½″ steps (builder). Stock listings: 4–12″ in 2″ steps |
| Lengths | **4, 5, 6, 8, 10, 12, 16, 20 or 24 ft** | **Any length from 2 to 30 ft, to the inch** (builder). Stock: 3–24 ft |
| Textures | **6**: Mena, Salvaged Timber, Rustic Sawn, Resawn Rip, Reclaimed Axed Cut, Sanded Smooth (Primed only) | **8**: Hand Hewn, Rough Sawn, Rough Cedar, Sandblasted, Pecky Cypress, Riverwood, Knotty Pine, Rustic Smooth |
| Finishes | **6 hand-stained + Primed**: Sandstone, Kona Brown, Vanilla Chai, Warm Caramel, Natural White Oak, Smokey Brown | **28 hand-finished + Factory Prepped**. The builder also has Espresso, Ebony and Russet; stock listings show 26 |
| Endcaps | Sold separately; they **ship unattached and unstained** | Choose **none, one or two** on the builder |
| Made in | Not listed as USA-made | **Made in the USA** |
| Sample | 3½″×5½″×8″ U-beam piece | 10″×7″ material sample |
| Price (same listing, Oct 2026) | 5½×5½×8 ft Kona Brown $186.48 · 7½×7½×12 ft $374.07 | 6×6×8 ft Rough Cedar Aged $367.53 · 8×8×12 ft $702.79 |

**Pick Heritage** when a standard size fits, you want it fast, and you want the lower price. Each
Heritage beam is roughly half the price of the nearest Timberthane size (four pairs checked).

**Pick Timberthane** when you need:
- an exact size, or something over 9½×11½ in or 24 ft;
- a plank, L-beam or box beam;
- one of its 8 textures or 28 stained finishes;
- endcaps chosen with the order, or a USA-made product.

## Both lines
- High-density polyurethane, hollow and lightweight. Both slide over a wood mounting block fixed to
  the ceiling, wall or doorway, and install with standard tools.
- The hollow inside can hide wiring, ductwork or LED strip lighting, and both lines can wrap an
  existing beam.
- Both lines are hand finished in batches, so colour can vary slightly between batches.
- Outdoors only with a proper UV-protective coating (FAQ, Heritage). Without one, a polyurethane beam
  may fade in direct sun.
- Install guide for both: `INSTALL_BMU` (cdn.synergycdn.com/pdf/installation/INSTALL_BMU.pdf).

## Inside openings (what fits over the block)
| Heritage | inside W×H | Timberthane | inside W×H |
|---|---|---|---|
| 3½×3½ | 2 × 2¾ | 4×4 | 1½ × 2¾ |
| 5½×5½ | 4 × 4¾ | 6×6 | 3½ × 4¾ |
| 7½×7½ | 6 × 6¾ | 8×8 | 5½ × 6¾ |
| 9½×9½ | 8 × 8¾ | 10×10 | 7½ × 8¾ |
| 3½×5½ | 2 × 4¾ | | |
| 5½×7½ | 4 × 6¾ | | |
| 7½×9½ | 6 × 8¾ | | |
| 9½×11½ | 8 × 8¾ ⚠ | | |

⚠ The 9½×11½ record lists an inside height of 8¾″, the same as the 9½×9½. It is probably a
data-entry error (about 10¾″ would be expected), so worth checking with the product team. The videos
show inside **widths** only, and those are consistent: outside width minus 1½″.

## Wording to be careful with
- **Counts.** The store gives three different Heritage counts: "56 popular sizes" (FAQ), "50 sizes"
  (short description), and 8 × 9 = 72 orderable combinations (variant data). Its long description
  also says "four distinct textures", while six can be ordered. The videos show the actual grid and
  don't state a total.
- **Timberthane finish count.** The builder has 29 options (28 stains + Factory Prepped), and the
  stock "-ST" listings have 26. The old FAQ figure was 25. The videos say "28 hand-finished colours".
- **Heritage lengths.** 16, 20 and 24 ft ship as one long item by freight (shipping length 193–289″).
  Don't claim one-piece moulding over 12 ft without checking with the plant.
- **No prices in the videos**: they change. "Lower price" is supported by the comparison above.

## Images
`img/assets.json` lists every image with its CDN source URL. All are Ekena's own product photography
from the listings:
- `img/heritage/product/<texture>/<finish>.jpg`: 36 real beams (6 textures, every finish they come in)
- `img/heritage/swatch/`: 7 finish swatches and 5 texture close-ups
- `img/timberthane/product/<texture>/<finish>.jpg`: 8 textures × 26 finishes
- `img/timberthane/builder/`: the builder's 29 finish swatches and 8 texture swatches
- `img/timberthane/shapes/`: plank, L-beam, U-beam and box beam for each texture
- `img/*/rooms/`: customer-project room photos from the listings' inspiration galleries (23 Heritage, 5 Timberthane)
- `img/*/angles/`, `img/*/accessories/`: extra angles, endcap, sample kits

## Sources
- Heritage listing: https://www.fauxbeams.com/Ekena-Millwork-Beams-BMSTS3
- Heritage variants: /php/product/get_variant_data.php?parentSku=BMSTS3&combinations=true
- Heritage product record: /php/product/get_flat_data.php?sku=BMSTS3C00400X0400X96KB
- Heritage FAQ: https://www.fauxbeams.com/quick-ship-faux-wood-beams
- Timberthane builder: https://www.fauxbeams.com/Ekena-Millwork-Beams-BM and /php/product/get_variant_builder_data.php?sku=BM
- Timberthane stock variants: /php/product/get_variant_data.php?parentSku=BMHH3-ST&combinations=true
- Timberthane product record: /php/product/get_flat_data.php?sku=BMHH3C0040X040X096ZD
- Option images: https://www.synergycdn.com/content/variant/get_variant_option_images.php

## Music
The Heritage hero edit uses "Peaceful" by Ondrosik (Ondrej Rosik), from his Free Music Catalog on the
Internet Archive (https://archive.org/details/Ondrosik-Free-music-catalog), marked CC0 1.0. The composer's
licence file, saved as `music/ondrosik-license.html`, allows use in videos, editing and sync, monetised
distribution with no royalties, and says attribution is welcome but not required. See `music/README.md`.
