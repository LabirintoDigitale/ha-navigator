"""Icona di Navigator: rosa dei venti con il quadrante pieno di 0 e 1.

I bit scritti sui cerchi sono il testo "NAVIGATOR LABIRINTO DIGITALE" in ASCII.
Uso: python docs/images/rosa.py <cartella_uscita>  (serve Pillow; font Georgia e Consolas di Windows)
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

S = 2048
C = S / 2
FONTS = "C:/Windows/Fonts/"
BITS = "".join(f"{ord(ch):08b}" for ch in "NAVIGATOR LABIRINTO DIGITALE ")


def pol(r, deg):
    """Punto a raggio r e angolo deg (0 = nord, senso orario)."""
    a = math.radians(deg)
    return (C + r * math.sin(a), C - r * math.cos(a))


def draw_icon(ink, paper, digit, with_letters=True):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    R_OUT, R_BAND, R_TEETH, R_IN = 700, 655, 600, 585
    if not with_letters:  # versione senza lettere: il quadrante occupa tutta l'icona
        k = 990 / 830
        R_OUT, R_BAND, R_TEETH, R_IN = (int(x * k) for x in (R_OUT, R_BAND, R_TEETH, R_IN))

    # punte esterne: cardinali grandi, intermedie piccole
    for i in range(16):
        deg = i * 22.5
        if i % 4 == 0:
            length, half = 140, 9
        elif i % 2 == 0:
            length, half = 60, 7
        else:
            length, half = 38, 5
        d.polygon([pol(R_OUT + length, deg), pol(R_OUT - 5, deg - half), pol(R_OUT - 5, deg + half)], fill=ink)

    # anello: fascia scura, dentini, cerchio sottile
    d.ellipse([C - R_OUT, C - R_OUT, C + R_OUT, C + R_OUT], fill=ink)
    d.ellipse([C - R_BAND, C - R_BAND, C + R_BAND, C + R_BAND], fill=paper)
    n_teeth = 72
    for i in range(n_teeth):
        a = i * 360 / n_teeth
        d.polygon([pol(R_BAND, a - 360 / n_teeth / 2), pol(R_BAND, a + 360 / n_teeth / 2), pol(R_TEETH + 8, a)], fill=ink)
    d.ellipse([C - R_TEETH, C - R_TEETH, C + R_TEETH, C + R_TEETH], fill=ink)
    d.ellipse([C - R_IN, C - R_IN, C + R_IN, C + R_IN], fill=paper)
    # pallini sulle diagonali, come nelle bussole antiche
    for deg in (45, 135, 225, 315):
        x, y = pol((R_BAND + R_OUT) / 2 - 2, deg)
        r = 26
        d.ellipse([x - r, y - r, x + r, y + r], fill=paper)
        d.ellipse([x - r + 9, y - r + 9, x + r - 9, y + r - 9], fill=ink)

    # quadrante: cerchi di 0 e 1 scritti lungo la circonferenza
    font_d = ImageFont.truetype(FONTS + "consolab.ttf", 46)
    glyphs = {}
    for ch in "01":
        g = Image.new("RGBA", (40, 56), (0, 0, 0, 0))
        ImageDraw.Draw(g).text((20, 28), ch, font=font_d, fill=digit, anchor="mm")
        glyphs[ch] = g
    k = 0
    r = R_IN - 40
    while r > 70:
        n = int(2 * math.pi * r / 34)
        for j in range(n):
            deg = j * 360 / n
            ch = BITS[k % len(BITS)]
            k += 1
            g = glyphs[ch].rotate(-deg, resample=Image.BICUBIC, expand=True)
            x, y = pol(r, deg)
            img.alpha_composite(g, (int(x - g.width / 2), int(y - g.height / 2)))
        r -= 52
    # cerchi guida sottili
    for rr in (R_IN * 0.72, R_IN * 0.45):
        d.ellipse([C - rr, C - rr, C + rr, C + rr], outline=ink, width=5)

    # rosa: 16 punte sottili, 4 diagonali, 4 cardinali (metà piena e metà vuota)
    def star_point(deg, length, half_w, width_outline):
        tip = pol(length, deg)
        left = pol(half_w, deg - 45)
        right = pol(half_w, deg + 45)
        d.polygon([(C, C), left, tip], fill=ink)
        d.polygon([(C, C), tip, right], fill=paper, outline=ink, width=width_outline)
        d.line([right, tip], fill=ink, width=width_outline)

    for i in range(16):
        if i % 2:
            star_point(i * 22.5, R_IN * 0.62, 40, 6)
    for deg in (45, 135, 225, 315):
        star_point(deg, R_IN * 0.80, 80, 8)
    for deg in (0, 90, 180, 270):
        star_point(deg, R_IN + 25, 120, 9)
    d.ellipse([C - 26, C - 26, C + 26, C + 26], fill=paper, outline=ink, width=8)

    if with_letters:
        big = ImageFont.truetype(FONTS + "georgiab.ttf", 250)
        small = ImageFont.truetype(FONTS + "georgiab.ttf", 120)
        for txt, deg, rr in (("N", 0, 895), ("E", 90, 865), ("S", 180, 895), ("W", 270, 850)):
            d.text(pol(rr, deg), txt, font=big, fill=ink, anchor="mm")
        for txt, deg in (("NE", 45), ("SE", 135), ("SW", 225), ("NW", 315)):
            d.text(pol(880, deg), txt, font=small, fill=ink, anchor="mm")
    return img


def save(img, path, size):
    img.resize((size, size), Image.LANCZOS).save(path, optimize=True)


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    light = draw_icon((20, 20, 20, 255), (255, 255, 255, 255), (130, 130, 130, 255))
    dark = draw_icon((240, 240, 240, 255), (28, 28, 28, 255), (140, 140, 140, 255))
    plain = draw_icon((20, 20, 20, 255), (255, 255, 255, 255), (130, 130, 130, 255), with_letters=False)
    save(light, out / "icon.png", 256)
    save(light, out / "icon@2x.png", 512)
    save(dark, out / "dark_icon.png", 256)
    save(dark, out / "dark_icon@2x.png", 512)
    save(plain, out / "plain.png", 256)
    save(light, out / "logo.png", 1024)
