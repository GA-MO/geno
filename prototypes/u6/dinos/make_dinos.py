"""Builds the three dinosaurs from their pixel grids: a mono 24x24 activity-bar SVG, a colored SVG avatar,
a 128x128 PNG icon, an inline-avatar module for the prototype pages, and docs/media/u6-proposals/dinos.png.
It builds the boxy Noodle variants the same way, with their own sheet, docs/media/u6-proposals/noodle-boxy.png.

Run: python3 prototypes/u6/dinos/make_dinos.py [--preview [--boxy]]
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
MEDIA = REPO / 'docs/media/u6-proposals'

# '.' empty, 'E' eye (a hole in the mono icon). Every other letter is a palette key.
DINOS = {
    'noodle': {
        'title': 'Noodle',
        'tile': '#1d3b35',
        'palette': {'B': '#5fc79a', 'S': '#3f9c78', 'L': '#bff0d4', 'A': '#ff9fb2', 'E': '#14231f', 'W': '#ffffff'},
        'grid': [
            '........................',
            '..............BBBBB.....',
            '.............BBBBBBBB...',
            '.............BBBBWEBBB..',
            '.............BBBBEEBBBB.',
            '.............BBBBBBBBBB.',
            '.............BBBBAABBB..',
            '.............BBBBB......',
            '.............BBBB.......',
            '............BBBBB.......',
            '............BBBB........',
            '............BBBB........',
            '......BBBBBBBBBB........',
            '....BBBBSBBBBSBBB.......',
            '...BBBBBBBBBBBBBBB......',
            '..BBBBSBBBBBSBBBBBB.....',
            '.BBBBBBBBBBBBBBBBBB.....',
            'BBB.BBLLLLLLLLLLBBB.....',
            'BB...BLLLLLLLLLLBB......',
            '.....SBB....SBB.........',
            '.....SBB....SBB.........',
            '.....SBB....SBB.........',
            '........................',
            '........................',
        ],
    },
    'plato': {
        'title': 'Plato',
        'tile': '#3a2a4d',
        'palette': {'B': '#a98bf0', 'S': '#7c62c8', 'L': '#e1d6ff', 'A': '#ffb454', 'E': '#1b1426', 'W': '#ffffff'},
        'grid': [
            '........................',
            '........................',
            '........................',
            '..........AA............',
            '.........AAAA...........',
            '.....AA..AAAA..AA.......',
            '....AAAA.AAAA.AAAA......',
            '....AAAA.AAAA.AAAA......',
            '....BBBBBBBBBBBBBBBB....',
            '...BBBBBBBBBBBBBBBBBB...',
            '..BBBBSBBBBBSBBBBBBBBBB.',
            '.ABBBBBBBBBBBBBBBBBBWEBB',
            'AABBSBBBBBSBBBBBBBBBEEBB',
            '.BBBBBBBBBBBBBBBBBBBBBBB',
            '.....BLLLLLLLLLLLBBBBAB.',
            '.....BLLLLLLLLLLLB......',
            '.....SBB.......SBB......',
            '.....SBB.......SBB......',
            '.....SBB.......SBB......',
            '........................',
            '........................',
            '........................',
            '........................',
            '........................',
        ],
    },
    'frill': {
        'title': 'Frill',
        'tile': '#4a2d22',
        'palette': {'B': '#ff9a62', 'S': '#d9713e', 'L': '#ffe0c2', 'F': '#e0583a', 'A': '#ffd166', 'E': '#2a160d', 'W': '#ffffff', 'H': '#fff3df'},
        'grid': [
            '........................',
            '........................',
            '...........FFF..........',
            '.........FFFFFF...H.....',
            '........FFAFFFFF..H.....',
            '........FFFFFFFF.HH.....',
            '.......FAFFFFFBBBBB.....',
            '.......FFFFFBBBBBBBB....',
            '.......FFFFBBBBBWEBB.H..',
            '...BBBBBFAFBBBBBEEBBBHH.',
            '..BBBBBBBFFBBBBBBBBBBBB.',
            '.BBBSBBBBSBBBBBBBBSSBBB.',
            'BBBBBBBBBBBBBBBBBBBBBB..',
            'BB.BBBBBBBBBBBBBBBBB....',
            '...BBLLLLLLLLLLLLBB.....',
            '...BBLLLLLLLLLLLLBB.....',
            '...SBBB......SBBB.......',
            '...SBBB......SBBB.......',
            '........................',
            '........................',
            '........................',
            '........................',
            '........................',
            '........................',
        ],
    },
}

# Boxy Noodle variants, in increasing boxiness. They share Noodle's palette and tile.
NOODLE = DINOS['noodle']
BOXY = {
    'noodle-box-a': {
        'title': 'Box A',
        'tile': NOODLE['tile'],
        'palette': NOODLE['palette'],
        'grid': [
            '........................',
            '.............BBBBBBBBB..',
            '.............BBBBBBBBB..',
            '.............BBBBWEBBB..',
            '.............BBBBEEBBB..',
            '.............BBBBBBBBB..',
            '.............BBBBAABBB..',
            '.............BBBB.......',
            '.............BBBB.......',
            '.............BBBB.......',
            '.............BBBB.......',
            '.............BBBB.......',
            '...BBBBBBBBBBBBBBB......',
            '...BBBBBSBBBBSBBBB......',
            'BBBBBBBBBBBBBBBBBB......',
            'BBBBBBSBBBBBSBBBBB......',
            '...BBBBBBBBBBBBBBB......',
            '...BBLLLLLLLLLLLBB......',
            '...BBLLLLLLLLLLLBB......',
            '....SBB......SBB........',
            '....SBB......SBB........',
            '....SBB......SBB........',
            '........................',
            '........................',
        ],
    },
    'noodle-box-b': {
        'title': 'Box B',
        'tile': NOODLE['tile'],
        'palette': NOODLE['palette'],
        'grid': [
            '........................',
            '.............BBBBBBBBB..',
            '.............BBBBBBBBB..',
            '.............BBBBWEBBB..',
            '.............BBBBEEBBB..',
            '.............BBBBBBBBB..',
            '.............BBBBAABBB..',
            '.............BBBBBBBBB..',
            '..............BBBB......',
            '..............BBBB......',
            '..BBBBBBBBBBBBBBBB......',
            '..BBBBBBSBBBBBSBBB......',
            '..BBBBBBBBBBBBBBBB......',
            'BBBBSBBBBBSBBBBBBB......',
            'BBBBBBBBBBBBBBBBBB......',
            '..BBBBBBBSBBBBBSBB......',
            '..BBBBBBBBBBBBBBBB......',
            '..BBLLLLLLLLLLLLBB......',
            '..BBLLLLLLLLLLLLBB......',
            '..BBBBBBBBBBBBBBBB......',
            '...SBBB......SBBB.......',
            '...SBBB......SBBB.......',
            '........................',
            '........................',
        ],
    },
    'noodle-box-c': {
        'title': 'Box C',
        'tile': NOODLE['tile'],
        'palette': NOODLE['palette'],
        'grid': [
            '........................',
            '........................',
            '.............BBBBBBB....',
            '.............BBWEBBB....',
            '.............BBEEAAB....',
            '.............BBBBBBB....',
            '.............BBB........',
            '.............BBB........',
            '.............BBB........',
            '.............BBB........',
            '.............BBB........',
            '..BBBBBBBBBBBBBB........',
            '..BBBBBSBBBBSBBB........',
            '..BBBBBBBBBBBBBB........',
            '..BBBSBBBBSBBBBB........',
            'BBBBBBBBBBBBBBBB........',
            '..BBBBBSBBBBSBBB........',
            '..BBBBBBBBBBBBBB........',
            '..BLLLLLLLLLLLLB........',
            '..BBBBBBBBBBBBBB........',
            '...SB......SB...........',
            '........................',
            '........................',
            '........................',
        ],
    },
}

SIZE = 24


def check(name, grid, palette):
    assert len(grid) == SIZE, f'{name}: {len(grid)} rows'
    for y, row in enumerate(grid):
        assert len(row) == SIZE, f'{name} row {y}: {len(row)} cols'
        for ch in row:
            assert ch == '.' or ch in palette, f'{name} row {y}: unknown {ch!r}'


def runs(grid, keep):
    """Horizontal runs of cells where keep(ch) holds, as (x, y, width, ch)."""
    out = []
    for y, row in enumerate(grid):
        x = 0
        while x < SIZE:
            ch = row[x]
            if not keep(ch):
                x += 1
                continue
            start = x
            while x < SIZE and row[x] == ch:
                x += 1
            out.append((start, y, x - start, ch))
    return out


def mono_svg(grid):
    # The eye and its shine stay holes, so the icon reads as a face at 16px.
    rects = ''.join(f'<rect x="{x}" y="{y}" width="{w}" height="1"/>' for x, y, w, _ in merged_runs(grid, lambda c: c not in '.EW'))
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" shape-rendering="crispEdges" fill="#000">{rects}</svg>\n'


def merged_runs(grid, keep):
    flat = [''.join('#' if keep(c) else '.' for c in row) for row in grid]
    return runs(flat, lambda c: c == '#')


def avatar_svg(grid, palette):
    rects = ''.join(f'<rect x="{x}" y="{y}" width="{w}" height="1" fill="{palette[c]}"/>' for x, y, w, c in runs(grid, lambda c: c != '.'))
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" shape-rendering="crispEdges">{rects}</svg>\n'


def grid_image(grid, palette, scale, color=None):
    img = Image.new('RGBA', (SIZE * scale, SIZE * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch == '.':
                continue
            if color is not None and ch in 'EW':
                continue
            fill = color if color is not None else palette[ch]
            draw.rectangle([x * scale, y * scale, (x + 1) * scale - 1, (y + 1) * scale - 1], fill=fill)
    return img


def icon_png(dino):
    """128x128: a 32-cell pixel tile with stepped corners, the 24-cell dino centered on it, 4px per cell."""
    cell = 4
    img = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    inset = [3, 1, 1]  # cells cut from each corner row, top to bottom, for a pixel-rounded square
    for y in range(32):
        cut = inset[y] if y < 3 else inset[31 - y] if y > 28 else 0
        draw.rectangle([cut * cell, y * cell, (32 - cut) * cell - 1, (y + 1) * cell - 1], fill=dino['tile'])
    body = grid_image(dino['grid'], dino['palette'], cell)
    bbox = body.getbbox()
    w, h = (bbox[2] - bbox[0]) // cell, (bbox[3] - bbox[1]) // cell
    ox, oy = (32 - w) // 2, (32 - h) // 2
    img.alpha_composite(body.crop(bbox), (ox * cell, oy * cell))
    return img


def font(size):
    for path in ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc']:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()


def sheet(dinos):
    """Each dino at 16, 24 and 128 on Dark Modern and Light Modern backgrounds, at 2x so it reads on a retina screen."""
    k = 2
    themes = [('Dark Modern', '#181818', '#d7d7d7', '#cccccc'), ('Light Modern', '#f8f8f8', '#1f1f1f', '#3b3b3b')]
    col = [150, 230, 310, 400, 480]  # mono 16, mono 24, avatar 16, avatar 24, icon 128
    row_h = 168
    width, height = 680, 44 + row_h * len(dinos)
    out = Image.new('RGB', (width * 2 * k, height * k), '#000')
    for t, (theme, bg, fg, text) in enumerate(themes):
        panel = Image.new('RGB', (width * k, height * k), bg)
        draw = ImageDraw.Draw(panel)
        draw.text((24 * k, 14 * k), theme, fill=text, font=font(13 * k))
        for label, x in zip(['mono 16', 'mono 24', 'avatar 16', 'avatar 24', 'icon 128'], col):
            draw.text((x * k, 14 * k), label, fill=text, font=font(11 * k))
        for i, dino in enumerate(dinos.values()):
            top = 44 + i * row_h
            mid = top + 64
            draw.text((24 * k, (mid - 8) * k), dino['title'], fill=text, font=font(14 * k))
            mono = grid_image(dino['grid'], dino['palette'], 8, color=fg)
            avatar = grid_image(dino['grid'], dino['palette'], 8)
            for img, size, x in [(mono, 16, col[0]), (mono, 24, col[1]), (avatar, 16, col[2]), (avatar, 24, col[3])]:
                scaled = img.resize((size * k, size * k), Image.Resampling.LANCZOS if size == 16 else Image.Resampling.NEAREST)
                panel.paste(scaled, (x * k, (mid - size // 2) * k), scaled)
            icon = icon_png(dino).resize((128 * k, 128 * k), Image.Resampling.NEAREST)
            panel.paste(icon, (col[4] * k, (mid - 64) * k), icon)
        out.paste(panel, (t * width * k, 0))
    return out


def preview(dinos):
    scale = 12
    tiles = [grid_image(d['grid'], d['palette'], scale) for d in dinos.values()]
    img = Image.new('RGB', (len(tiles) * (SIZE * scale + 24) + 24, SIZE * scale + 48), '#202020')
    draw = ImageDraw.Draw(img)
    for i, tile in enumerate(tiles):
        x = 24 + i * (SIZE * scale + 24)
        for g in range(SIZE + 1):
            draw.line([x + g * scale, 24, x + g * scale, 24 + SIZE * scale], fill='#2c2c2c')
            draw.line([x, 24 + g * scale, x + SIZE * scale, 24 + g * scale], fill='#2c2c2c')
        img.paste(tile, (x, 24), tile)
    return img


def main():
    for name, dino in {**DINOS, **BOXY}.items():
        check(name, dino['grid'], dino['palette'])
    if '--preview' in sys.argv:
        path = Path(sys.argv[-1]) if sys.argv[-1].endswith('.png') else HERE / 'preview.png'
        preview({'noodle': NOODLE, **BOXY} if '--boxy' in sys.argv else DINOS).save(path)
        print(path)
        return
    MEDIA.mkdir(parents=True, exist_ok=True)
    avatars = {}
    for name, dino in {**DINOS, **BOXY}.items():
        (HERE / f'{name}-mono.svg').write_text(mono_svg(dino['grid']))
        avatars[name] = avatar_svg(dino['grid'], dino['palette']).strip()
        (HERE / f'{name}-avatar.svg').write_text(avatars[name] + '\n')
        icon_png(dino).save(HERE / f'{name}-128.png')
    (HERE.parent / 'shared/dinos.js').write_text(f'window.DINOS = {json.dumps({n: avatars[n] for n in DINOS}, indent=2)};\n')
    sheet(DINOS).save(MEDIA / 'dinos.png')
    sheet({'noodle': NOODLE, **BOXY}).save(MEDIA / 'noodle-boxy.png')
    print('wrote', MEDIA / 'dinos.png', MEDIA / 'noodle-boxy.png')


if __name__ == '__main__':
    main()
