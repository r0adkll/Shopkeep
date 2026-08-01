#!/usr/bin/env bash
# Seeds a realistic full-scale dev inventory (~50 materials, mixed health,
# ledger activity on several) to exercise the UI at density. Additive — it
# will not run against a database that already has more than 15 materials.
#
# Auth: set SHOPKEEP_EMAIL + SHOPKEEP_PASSWORD, or SHOPKEEP_SESSION (cookie value).
# Host: first arg, default http://localhost:8080
#
# Clean slate afterwards (dev db only!):
#   psql: TRUNCATE inventory_transactions, materials RESTART IDENTITY CASCADE;
set -euo pipefail
HOST="${1:-http://localhost:8080}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

if [ -n "${SHOPKEEP_SESSION:-}" ]; then
  printf 'localhost\tFALSE\t/\tFALSE\t0\tshopkeep_session\t%s\n' "$SHOPKEEP_SESSION" > "$JAR"
elif [ -n "${SHOPKEEP_EMAIL:-}" ]; then
  curl -sf -c "$JAR" -H 'Content-Type: application/json' -X POST "$HOST/api/v1/auth/login" \
    -d "{\"email\":\"$SHOPKEEP_EMAIL\",\"password\":\"$SHOPKEEP_PASSWORD\"}" > /dev/null
else
  echo "Set SHOPKEEP_EMAIL/SHOPKEEP_PASSWORD or SHOPKEEP_SESSION" >&2; exit 1
fi

C() { curl -sf -b "$JAR" -H 'Content-Type: application/json' "$@"; }

COUNT=$(C "$HOST/api/v1/inventory/materials" | grep -o '"id":' | wc -l | tr -d ' ')
if [ "$COUNT" -gt 15 ]; then
  echo "Already $COUNT materials — refusing to seed again (see script header for cleanup)." >&2
  exit 1
fi

# mat name category type unit costMinor costQty threshold reorder full color vendor initialQty
mat() {
  local color_json="" vendor_json=""
  [ -n "${10}" ] && color_json=",\"attributes\":{\"color\":\"${10}\"}"
  [ -n "${11}" ] && vendor_json=",\"vendorUrl\":\"${11}\""
  local thr="null" reo="null" full="null"
  [ "$7" != "-" ] && thr="$7"; [ "$8" != "-" ] && reo="$8"; [ "$9" != "-" ] && full="$9"
  C -X POST "$HOST/api/v1/inventory/materials" -d "{\"material\":{\"name\":\"$1\",\"category\":\"$2\",\"type\":\"$3\",\"unit\":\"$4\",\"costMinor\":$5,\"costQuantity\":$6,\"lowStockThreshold\":$thr,\"reorderQuantity\":$reo,\"fullQuantity\":$full$color_json$vendor_json},\"initialQuantity\":${12}}" \
    | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2
}
tx() { C -X POST "$HOST/api/v1/inventory/materials/$1/transactions" -d "{\"delta\":$2,\"kind\":\"$3\",\"note\":\"$4\"}" > /dev/null; }

B="https://us.store.bambulab.com"
M="https://www.mcmaster.com"
U="https://www.uline.com"

echo "Seeding filaments…"
# PLA Matte
mat "PLA Matte Ash Gray"      filament "PLA Matte" g 1999 1000 150 1000 1000 "#9ea1a5" "$B" 740 >/dev/null
mat "PLA Matte Latte Brown"   filament "PLA Matte" g 1999 1000 150 1000 1000 "#b59a7e" "$B" 380 >/dev/null
mat "PLA Matte Dark Green"    filament "PLA Matte" g 1999 1000 150 1000 1000 "#2e5b3f" "$B" 925 >/dev/null
mat "PLA Matte Marine Blue"   filament "PLA Matte" g 1999 1000 150 1000 1000 "#2b4b7a" "$B" 130 >/dev/null
mat "PLA Matte Lilac Purple"  filament "PLA Matte" g 1999 1000 150 1000 1000 "#9b8fc0" "$B" 610 >/dev/null
mat "PLA Matte Mandarin"      filament "PLA Matte" g 1999 1000 150 1000 1000 "#e8792f" "$B" 66 >/dev/null
mat "PLA Matte Lemon Yellow"  filament "PLA Matte" g 1999 1000 150 1000 1000 "#f2d24b" "$B" 480 >/dev/null
mat "PLA Matte Terracotta"    filament "PLA Matte" g 1999 1000 150 1000 1000 "#c86048" "$B" 1730 >/dev/null
mat "PLA Matte Ice Blue"      filament "PLA Matte" g 1999 1000 150 1000 1000 "#a9c8e0" "$B" 220 >/dev/null
mat "PLA Matte Grass Green"   filament "PLA Matte" g 1999 1000 150 1000 1000 "#5c9e49" "$B" 0 >/dev/null
mat "PLA Matte Dark Red"      filament "PLA Matte" g 1999 1000 150 1000 1000 "#8a2b2b" "$B" 840 >/dev/null
mat "PLA Matte Nardo Gray"    filament "PLA Matte" g 1999 1000 150 1000 1000 "#6f7377" "$B" 2150 >/dev/null
mat "PLA Matte Milk White"    filament "PLA Matte" g 1999 1000 150 1000 1000 "#efece4" "$B" 470 >/dev/null
# PLA Basic
mat "PLA Basic Jet Black"     filament "PLA Basic" g 1799 1000 200 2000 1000 "#1c1d1f" "$B" 2870 >/dev/null
mat "PLA Basic Snow White"    filament "PLA Basic" g 1799 1000 200 2000 1000 "#f2f0ea" "$B" 1240 >/dev/null
mat "PLA Basic Bambu Green"   filament "PLA Basic" g 1799 1000 150 1000 1000 "#3aa66a" "$B" 560 >/dev/null
mat "PLA Basic Orange"        filament "PLA Basic" g 1799 1000 150 1000 1000 "#e87c1e" "$B" 315 >/dev/null
mat "PLA Basic Purple"        filament "PLA Basic" g 1799 1000 150 1000 1000 "#7a5fb5" "$B" 90 >/dev/null
mat "PLA Basic Cyan"          filament "PLA Basic" g 1799 1000 150 1000 1000 "#2fa3c7" "$B" 655 >/dev/null
mat "PLA Basic Pink"          filament "PLA Basic" g 1799 1000 150 1000 1000 "#e58cb1" "$B" 505 >/dev/null
mat "PLA Basic Gold"          filament "PLA Basic" g 1799 1000 150 1000 1000 "#c9a23a" "$B" 45 >/dev/null
mat "PLA Basic Silver"        filament "PLA Basic" g 1799 1000 150 1000 1000 "#b9bcc0" "$B" 780 >/dev/null
# Silk + PETG
mat "PLA Silk Gold"           filament "PLA Silk" g 2499 1000 100 1000 1000 "#d4af37" "$B" 340 >/dev/null
mat "PLA Silk Copper"         filament "PLA Silk" g 2499 1000 100 1000 1000 "#b87333" "$B" 590 >/dev/null
mat "PLA Silk Sapphire"       filament "PLA Silk" g 2499 1000 100 1000 1000 "#3b6bd6" "$B" 120 >/dev/null
mat "PETG Basic Black"        filament "PETG"     g 2199 1000 150 1000 1000 "#232427" "$B" 940 >/dev/null
mat "PETG Basic White"        filament "PETG"     g 2199 1000 150 1000 1000 "#e8e8e6" "$B" 275 >/dev/null
mat "PETG Translucent Teal"   filament "PETG"     g 2399 1000 100 1000 1000 "#3fa8a0" "$B" 620 >/dev/null

echo "Seeding hardware…"
mat "M3x8 screws"        hardware screw          piece  749 100 100 200 -   "" "$M" 350 >/dev/null
mat "M2x6 screws"        hardware screw          piece  649 100 100 200 -   "" "$M" 80 >/dev/null
mat "M3 heat inserts"    hardware "heat insert"  piece 1450 100  50 100 -   "" "$M" 210 >/dev/null
mat "M2 heat inserts"    hardware "heat insert"  piece 1250 100  50 100 -   "" "$M" 35 >/dev/null
mat "Magnets 6x3 black"  hardware magnet         piece 1250 100 100 200 -   "" ""   310 >/dev/null
mat "Magnets 8x3"        hardware magnet         piece 1550 100  60 100 -   "" ""   55 >/dev/null
mat "Springs 10mm"       hardware spring         piece  899  50  30  50 -   "" "$M" 120 >/dev/null
mat "608 bearings"       hardware bearing        piece 1199  20  10  20 -   "" ""   18 >/dev/null
mat "Rubber feet"        hardware "rubber foot"  piece  550 100 100 200 -   "" ""   400 >/dev/null

echo "Seeding packaging…"
mat "Large box (2-4 item)"  packaging box           piece 5900 50 25 50 50 "" "$U" 64 >/dev/null
mat "XL box (custom)"       packaging box           piece 7200 25 10 25 25 "" "$U" 12 >/dev/null
mat "Poly mailer 10x13"     packaging mailer        piece 1899 100 30 100 -  "" "$U" 85 >/dev/null
mat "Bubble mailer 8x11"    packaging mailer        piece 2250 100 25 100 -  "" "$U" 22 >/dev/null
mat "Shipping labels 4x6"   packaging label         piece 2799 500 100 500 - "" ""   140 >/dev/null
mat "Thank-you insert cards" packaging "insert card" piece 3400 250 40 250 - "" ""   56 >/dev/null
mat "Logo stickers"         packaging sticker       piece 4200 500 100 500 - "" ""   480 >/dev/null
mat "Bubble wrap"           packaging "bubble wrap" m     2499 100 10 100 -  "" "$U" 30 >/dev/null
mat "Kraft void fill"       packaging "void fill"   m     1999 150 50 150 -  "" ""   200 >/dev/null
mat "Fragile tape"          packaging tape          roll  1099 6   3   6  -  "" ""   2 >/dev/null

echo "Adding ledger activity for chart shape…"
ALL=$(C "$HOST/api/v1/inventory/materials")
idOf() { echo "$ALL" | grep -o "{\"id\":[0-9]*,\"name\":\"$1\"" | grep -o '[0-9]*' | head -1; }
for spec in \
  "PLA Matte Ash Gray|-120|CONSUMPTION|case batch #31" \
  "PLA Matte Ash Gray|1000|PURCHASE|Bambu order" \
  "PLA Matte Ash Gray|-260|CONSUMPTION|case batch #33" \
  "PLA Basic Jet Black|-340|CONSUMPTION|case batch #32" \
  "PLA Basic Jet Black|-180|CONSUMPTION|custom order" \
  "PLA Silk Gold|-95|CONSUMPTION|trophy order" \
  "PETG Basic Black|1000|PURCHASE|restock" \
  "PETG Basic Black|-410|CONSUMPTION|bracket batch" \
  "M3x8 screws|-48|CONSUMPTION|case batch #33" \
  "M3x8 screws|200|PURCHASE|McMaster order" \
  "Large box (2-4 item)|-11|CONSUMPTION|week 30 shipments" \
  "Thank-you insert cards|-24|CONSUMPTION|week 30 shipments" \
  ; do
  IFS="|" read -r name delta kind note <<< "$spec"
  ID=$(idOf "$name"); [ -n "$ID" ] && tx "$ID" "$delta" "$kind" "$note"
done

echo "Done: $(C "$HOST/api/v1/inventory/materials" | grep -o '"id":' | wc -l | tr -d ' ') materials."
