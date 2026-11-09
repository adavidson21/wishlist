"""Builds the README graphics in docs/images/. Run from the repo root: python3 scripts/readme-images.py"""
import os, re

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.join(repo, "docs", "images")
os.makedirs(out, exist_ok=True)
MARK = re.search(r' d="([^"]+)"', open(os.path.join(repo, "public", "icons", "mark.svg")).read()).group(1)

WINE = "#82263C"
WINE_DK = "#5E1A2B"
CREAM = "#FAF6F1"
INK = "#2A1E22"
MUTED = "#6E5A60"
GOLD = "#D9A94A"
GOLD_SOFT = "#FBF1DC"
GOLD_INK = "#7A5410"
PINE = "#2F5D4A"
PINE_SOFT = "#E3EFE8"
LINE = "#E8DED6"
FONT = "font-family=\"-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif\""


def write(name, body, w, h):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" {FONT}>\n{body}\n</svg>\n'
    open(os.path.join(out, name), "w").write(svg)


def logo(x, y, size, fill):
    # mark.svg viewBox is 365 310 624 569
    sc = size / 624
    return f'<path transform="translate({x} {y}) scale({sc:.4f}) translate(-365 -310)" fill="{fill}" fill-rule="evenodd" d="{MARK}"/>'


def gift(x, y, s, box, ribbon, rot=0):
    w = s; h = s * 0.8
    return f'''<g transform="translate({x} {y}) rotate({rot})">
  <rect x="{-w/2}" y="{-h/2 + s*0.12}" width="{w}" height="{h}" rx="{s*0.08}" fill="{box}"/>
  <rect x="{-w/2 - s*0.06}" y="{-h/2}" width="{w + s*0.12}" height="{s*0.24}" rx="{s*0.06}" fill="{box}" stroke="{CREAM}" stroke-opacity=".35" stroke-width="2"/>
  <rect x="{-s*0.07}" y="{-h/2}" width="{s*0.14}" height="{h + s*0.12}" fill="{ribbon}"/>
  <path d="M0 {-h/2} C {-s*0.3} {-h/2 - s*0.32}, {-s*0.42} {-h/2 - s*0.02}, 0 {-h/2}" fill="none" stroke="{ribbon}" stroke-width="{s*0.07}" stroke-linecap="round"/>
  <path d="M0 {-h/2} C {s*0.3} {-h/2 - s*0.32}, {s*0.42} {-h/2 - s*0.02}, 0 {-h/2}" fill="none" stroke="{ribbon}" stroke-width="{s*0.07}" stroke-linecap="round"/>
</g>'''


def sparkle(x, y, r, c):
    return f'<path transform="translate({x} {y})" fill="{c}" d="M0 {-r} C {r*0.15} {-r*0.15}, {r*0.15} {-r*0.15}, {r} 0 C {r*0.15} {r*0.15}, {r*0.15} {r*0.15}, 0 {r} C {-r*0.15} {r*0.15}, {-r*0.15} {r*0.15}, {-r} 0 C {-r*0.15} {-r*0.15}, {-r*0.15} {-r*0.15}, 0 {-r} Z"/>'


# ---------- hero ----------
W, H = 1200, 440
b = [f'<rect width="{W}" height="{H}" rx="28" fill="{WINE}"/>',
     f'<circle cx="1080" cy="40" r="220" fill="{WINE_DK}" opacity=".55"/>',
     f'<circle cx="820" cy="470" r="160" fill="{WINE_DK}" opacity=".45"/>']
for (x, y, r, o) in [(80, 380, 3, .5), (300, 60, 2.5, .6), (520, 400, 3, .4), (640, 50, 2, .5), (1140, 400, 3, .5), (720, 230, 2, .4), (1000, 330, 2.5, .5), (240, 300, 2, .35)]:
    b.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" opacity="{o}"/>')
b.append(logo(72, 70, 84, "#FFFFFF"))
b.append(f'<text x="172" y="138" font-size="72" font-weight="800" fill="#fff" letter-spacing="-1.5">Hints</text>')
b.append(f'<text x="72" y="222" font-size="38" font-weight="700" fill="#fff">Wish lists for the people you love.</text>')
b.append(f'<text x="72" y="270" font-size="38" font-weight="700" fill="{GOLD}">Surprises stay surprises.</text>')
b.append(f'<text x="72" y="330" font-size="22" fill="#F3DCE2">Share what you’d like. See what your family is hoping for.</text>')
b.append(f'<text x="72" y="362" font-size="22" fill="#F3DCE2">Quietly mark what you’re getting, and nobody gets a double.</text>')
# phone card
px, py = 820, 70
b.append(f'<g transform="rotate(4 {px+130} {py+150})">')
b.append(f'<rect x="{px}" y="{py}" width="260" height="310" rx="30" fill="{CREAM}" stroke="#fff" stroke-width="6"/>')
b.append(f'<text x="{px+24}" y="{py+46}" font-size="20" font-weight="800" fill="{INK}">Grandma’s list</text>')
rows = [("🧣", "Cozy plaid scarf", "$38", None), ("📚", "Mystery novel", "$17", "taken"), ("🌷", "Tulip bulbs", "$24", "star"), ("☕", "Pottery mug set", "$45", None)]
for i, (em, name, price, tag) in enumerate(rows):
    ry = py + 70 + i * 56
    b.append(f'<rect x="{px+16}" y="{ry}" width="228" height="46" rx="12" fill="#fff" stroke="{LINE}"/>')
    b.append(f'<text x="{px+30}" y="{ry+31}" font-size="20">{em}</text>')
    b.append(f'<text x="{px+62}" y="{ry+21}" font-size="14" font-weight="700" fill="{INK}">{name}</text>')
    b.append(f'<text x="{px+62}" y="{ry+38}" font-size="12.5" fill="{MUTED}">{price}</text>')
    if tag == "taken":
        b.append(f'<rect x="{px+168}" y="{ry+13}" width="66" height="20" rx="10" fill="{PINE}"/><text x="{px+201}" y="{ry+27}" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">Taken ✓</text>')
    if tag == "star":
        b.append(f'<rect x="{px+168}" y="{ry+13}" width="66" height="20" rx="10" fill="{GOLD}"/><text x="{px+201}" y="{ry+27}" font-size="11" font-weight="700" fill="{INK}" text-anchor="middle">★ Top pick</text>')
b.append('</g>')
b.append(gift(770, 350, 74, GOLD, WINE_DK, -10))
b.append(gift(1120, 300, 58, PINE, GOLD, 8))
b.append(sparkle(770, 95, 16, GOLD))
b.append(sparkle(1130, 120, 11, "#fff"))
write("hero.svg", "\n".join(b), W, H)

# ---------- how it works ----------
W, H = 1200, 330
steps = [
    ("✉️", "Join", ["Open the invite link", "from your family and", "tap your name."]),
    ("📝", "Add wishes", ["Paste a store link.", "The name, photo and", "price fill themselves."]),
    ("👀", "Peek at lists", ["See what everyone", "is hoping for, sorted", "by person."]),
    ("🎁", "Claim a gift", ["Tap “I’ll get this.”", "Everyone else sees it’s", "taken. They never do."]),
]
b = [f'<rect width="{W}" height="{H}" rx="24" fill="{CREAM}"/>']
cw, gap, x0 = 258, 22, 40
for i, (em, title, lines) in enumerate(steps):
    x = x0 + i * (cw + gap)
    b.append(f'<rect x="{x}" y="36" width="{cw}" height="258" rx="20" fill="#fff" stroke="{LINE}" stroke-width="2"/>')
    b.append(f'<circle cx="{x+40}" cy="76" r="20" fill="{WINE}"/><text x="{x+40}" y="83" font-size="19" font-weight="800" fill="#fff" text-anchor="middle">{i+1}</text>')
    b.append(f'<text x="{x+cw-34}" y="92" font-size="40" text-anchor="middle">{em}</text>')
    b.append(f'<text x="{x+24}" y="148" font-size="27" font-weight="800" fill="{INK}">{title}</text>')
    for j, ln in enumerate(lines):
        b.append(f'<text x="{x+24}" y="{190 + j*28}" font-size="18" fill="{MUTED}">{ln}</text>')
    if i < 3:
        ax = x + cw + gap / 2
        b.append(f'<path d="M{ax-6} 157 l8 8 -8 8" fill="none" stroke="{GOLD}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>')
write("how-it-works.svg", "\n".join(b), W, H)

# ---------- who sees what ----------
rows = [
    ("Wishes on your list", "You choose which circles", "✓", "✓", "self"),
    ("Wishes still in “Maybe”", "Drafts, just for you", "✓", "✗", "self"),
    ("What you’re getting someone", "Others see “taken” so no doubles", "✓", "✓", "✗"),
    ("Your private gift ideas", "Notes to yourself", "✓", "✗", "✗"),
    ("Suggestions you share", "Ideas for the rest of the circle", "✓", "✓", "✗"),
    ("The chat about someone", "The back channel", "✓", "✓", "✗"),
]
rh, top = 72, 150
W, H = 1200, top + len(rows) * rh + 70
cols = [(720, "You"), (880, "Your circle"), (1060, "The person it’s for")]
b = [f'<rect width="{W}" height="{H}" rx="24" fill="{CREAM}"/>',
     f'<text x="44" y="64" font-size="32" font-weight="800" fill="{INK}">Who sees what</text>',
     f'<text x="44" y="98" font-size="19" fill="{MUTED}">Hints enforces this behind the scenes, not just by hiding things on screen. The person a gift is for can never see it.</text>']
for cx, label in cols:
    b.append(f'<text x="{cx}" y="{top-14}" font-size="17" font-weight="800" fill="{INK}" text-anchor="middle">{label}</text>')
for i, (t, sub, a, c, p) in enumerate(rows):
    y = top + i * rh
    b.append(f'<rect x="28" y="{y}" width="{W-56}" height="{rh-10}" rx="16" fill="#fff" stroke="{LINE}" stroke-width="1.5"/>')
    b.append(f'<text x="52" y="{y+28}" font-size="20" font-weight="700" fill="{INK}">{t}</text>')
    b.append(f'<text x="52" y="{y+51}" font-size="15.5" fill="{MUTED}">{sub}</text>')
    for (cx, _), v in zip(cols, (a, c, p)):
        cy = y + (rh - 10) / 2
        if v == "✓":
            b.append(f'<circle cx="{cx}" cy="{cy}" r="17" fill="{PINE_SOFT}"/><path d="M{cx-7} {cy} l5 5 9-10" fill="none" stroke="{PINE}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>')
        elif v == "✗":
            b.append(f'<circle cx="{cx}" cy="{cy}" r="17" fill="#F6E1E6"/><path d="M{cx-6} {cy-6} l12 12 M{cx+6} {cy-6} l-12 12" stroke="{WINE}" stroke-width="3.5" stroke-linecap="round"/>')
        else:
            b.append(f'<text x="{cx}" y="{cy+6}" font-size="15" fill="{MUTED}" text-anchor="middle">That’s you</text>')
b.append(f'<text x="44" y="{H-26}" font-size="15.5" fill="{MUTED}">Your circle means the people you share a circle with (like “Family Christmas”). People outside your circles see nothing.</text>')
write("who-sees-what.svg", "\n".join(b), W, H)

# ---------- you vs gifts (AI) ----------
W, H = 1200, 560
b = [f'<rect width="{W}" height="{H}" rx="24" fill="{CREAM}"/>',
     f'<text x="44" y="64" font-size="32" font-weight="800" fill="{INK}">Your info vs. gift info</text>',
     f'<text x="44" y="98" font-size="19" fill="{MUTED}">Hints keeps two kinds of things, and treats them differently.</text>']
# left card
lx, ly, cw, chh = 40, 128, 545, 396
b.append(f'<rect x="{lx}" y="{ly}" width="{cw}" height="{chh}" rx="22" fill="#fff" stroke="{PINE}" stroke-width="3"/>')
b.append(f'<rect x="{lx}" y="{ly}" width="{cw}" height="78" rx="22" fill="{PINE}"/><rect x="{lx}" y="{ly+50}" width="{cw}" height="28" fill="{PINE}"/>')
b.append(f'<text x="{lx+28}" y="{ly+50}" font-size="25" font-weight="800" fill="#fff">🙂  About you</text>')
items = ["Your profile photo (your face)", "Your name and birthday", "Sizes, loves, nopes, allergies", "Pet and household photos", "Your PIN and which circles you're in"]
for i, t in enumerate(items):
    y = ly + 122 + i * 40
    b.append(f'<circle cx="{lx+40}" cy="{y-6}" r="5" fill="{PINE}"/><text x="{lx+58}" y="{y}" font-size="19" fill="{INK}">{t}</text>')
b.append(f'<rect x="{lx+24}" y="{ly+chh-92}" width="{cw-48}" height="68" rx="14" fill="{PINE_SOFT}"/>')
b.append(f'<text x="{lx+44}" y="{ly+chh-52}" font-size="21" font-weight="800" fill="{PINE}">🚫🤖  Never sent to any AI. Ever.</text>')
# right card
rx = 615
b.append(f'<rect x="{rx}" y="{ly}" width="{cw}" height="{chh}" rx="22" fill="#fff" stroke="{GOLD}" stroke-width="3"/>')
b.append(f'<rect x="{rx}" y="{ly}" width="{cw}" height="78" rx="22" fill="{GOLD}"/><rect x="{rx}" y="{ly+50}" width="{cw}" height="28" fill="{GOLD}"/>')
b.append(f'<text x="{rx+28}" y="{ly+50}" font-size="25" font-weight="800" fill="{INK}">🎁  About gifts</text>')
items = ["A wish’s name, store link and brand", "The size or color picked on a wish", "A photo of a product you search for", "(Never who it’s for, or anyone’s face)"]
for i, t in enumerate(items):
    y = ly + 122 + i * 40
    col = MUTED if t.startswith("(") else INK
    if not t.startswith("("):
        b.append(f'<circle cx="{rx+40}" cy="{y-6}" r="5" fill="{GOLD}"/>')
    b.append(f'<text x="{rx+58}" y="{y}" font-size="19" fill="{col}">{t}</text>')
b.append(f'<rect x="{rx+24}" y="{ly+chh-120}" width="{cw-48}" height="96" rx="14" fill="{GOLD_SOFT}"/>')
b.append(f'<text x="{rx+44}" y="{ly+chh-80}" font-size="19" font-weight="800" fill="{GOLD_INK}">✨  Can go to Google Gemini to find</text>')
b.append(f'<text x="{rx+44}" y="{ly+chh-52}" font-size="19" font-weight="800" fill="{GOLD_INK}">the product. Not used to train AI.</text>')
write("your-info-vs-gift-info.svg", "\n".join(b), W, H)
print("ok")
