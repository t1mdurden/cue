#!/usr/bin/env python3
"""Regenerate the synthetic test fixtures: a 1920x1080 "screen" PNG with known text and a spoken WAV.

Tests and the latency bench read only these files, never the live desktop or microphone.
    python3 scripts/make-fixtures.py        # needs Pillow and macOS `say`
"""
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

out = Path(__file__).resolve().parent.parent / "test" / "fixtures"
out.mkdir(parents=True, exist_ok=True)

font = "/System/Library/Fonts/Supplemental/Arial.ttf"
mono = "/System/Library/Fonts/Menlo.ttc"
img = Image.new("RGB", (1920, 1080), "#f6f7f9")
draw = ImageDraw.Draw(img)
draw.rectangle([0, 0, 1920, 64], fill="#1f2937")
draw.text((32, 18), "Billing - Acme Cloud Console", font=ImageFont.truetype(font, 26), fill="white")
draw.rectangle([0, 64, 300, 1080], fill="#e5e7eb")
for i, item in enumerate(["Overview", "Invoices", "Usage", "Team", "Settings"]):
    draw.text((32, 110 + i * 56), item, font=ImageFont.truetype(font, 24), fill="#111827")
draw.text((360, 110), "Invoice CUE-PROBE-4471", font=ImageFont.truetype(font, 44), fill="#111827")
rows = [("Compute (412 vCPU-hours)", "520.00"), ("Object storage (3.1 TB)", "201.90"), ("Egress (840 GB)", "90.50")]
for i, (name, amount) in enumerate(rows):
    y = 210 + i * 60
    draw.text((360, y), name, font=ImageFont.truetype(font, 30), fill="#374151")
    draw.text((1300, y), amount, font=ImageFont.truetype(font, 30), fill="#374151")
draw.line([360, 400, 1500, 400], fill="#9ca3af", width=2)
draw.text((360, 420), "Total due", font=ImageFont.truetype(font, 34), fill="#111827")
draw.text((1300, 420), "812.40 USD", font=ImageFont.truetype(font, 34), fill="#111827")
code = [
    "def apply_discount(total, code):",
    "    if code == 'SPRING':",
    "        return total * 0.9",
    "    return total",
]
draw.rectangle([360, 520, 1500, 760], fill="#0f172a")
for i, line in enumerate(code):
    draw.text((390, 545 + i * 48), line, font=ImageFont.truetype(mono, 28), fill="#e2e8f0")
img.save(out / "screen-probe.png", optimize=True)

# A dense screen: an editor full of 15 px text, the way a real 1920 px capture of a laptop display
# looks. The same facts sit in one small line, so a vision budget that cannot read small text fails.
img = Image.new("RGB", (1920, 1080), "#1e1e1e")
draw = ImageDraw.Draw(img)
small = ImageFont.truetype(mono, 15)
ui = ImageFont.truetype(font, 15)
draw.rectangle([0, 0, 1920, 30], fill="#323233")
draw.text((12, 7), "billing_report.py - acme-cloud - Visual Studio Code", font=ui, fill="#cccccc")
draw.rectangle([0, 30, 260, 1080], fill="#252526")
for i, name in enumerate(["src", "  billing_report.py", "  invoices.py", "  discounts.py", "  models.py", "tests", "  test_billing.py", "README.md", "pyproject.toml"]):
    draw.text((14, 44 + i * 22), name, font=ui, fill="#c5c5c5")
filler = [
    "import csv", "from decimal import Decimal", "from invoices import load_invoice, line_items", "",
    "def summarize(invoice_id: str) -> dict:", "    invoice = load_invoice(invoice_id)", "    items = line_items(invoice)",
    "    subtotal = sum(Decimal(i.amount) for i in items)", "    tax = (subtotal * Decimal('0.0')).quantize(Decimal('0.01'))",
    "    return {'id': invoice_id, 'subtotal': subtotal, 'tax': tax, 'count': len(items)}", "",
    "def export(rows, path):", "    with open(path, 'w', newline='') as fh:", "        writer = csv.writer(fh)",
    "        writer.writerow(['id', 'subtotal', 'tax', 'count'])", "        for row in rows:",
    "            writer.writerow([row['id'], row['subtotal'], row['tax'], row['count']])", "",
]
for i in range(40):
    line = filler[i % len(filler)]
    draw.text((280, 44 + i * 21), f"{i + 1:>3}  {line}", font=small, fill="#d4d4d4")
draw.rectangle([1340, 30, 1920, 1080], fill="#1b1b1c")
draw.text((1356, 44), "TERMINAL", font=ui, fill="#8a8a8a")
log = ["$ python billing_report.py --month 2026-09", "loading 3 invoices ...", "CUE-PROBE-4471  compute   520.00",
       "CUE-PROBE-4471  storage   201.90", "CUE-PROBE-4471  egress     90.50", "Invoice CUE-PROBE-4471 total due: 812.40 USD",
       "export written to out/september.csv", "$ "]
for i, line in enumerate(log):
    draw.text((1356, 74 + i * 21), line, font=small, fill="#cccccc")
img.save(out / "screen-dense.png", optimize=True)

subprocess.run(
    ["say", "-o", str(out / "speech-budget.wav"), "--data-format=LEI16@16000",
     "The quarterly budget is forty two thousand dollars."],
    check=True,
)
print(f"wrote {out}/screen-probe.png and speech-budget.wav")
