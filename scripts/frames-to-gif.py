"""Stitches PNG stills into a looping GIF with one palette for every frame, so colors hold steady between frames.

Run: python3 scripts/frames-to-gif.py <out.gif> <ms per frame> <frame.png>...
"""
import sys

from PIL import Image


def main():
    out, ms, paths = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
    frames = [Image.open(p).convert('RGB') for p in paths]
    w, h = frames[0].size
    sheet = Image.new('RGB', (w, h * len(frames)))
    for i, frame in enumerate(frames):
        sheet.paste(frame, (0, h * i))
    palette = sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    quantized = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    quantized[0].save(out, save_all=True, append_images=quantized[1:], duration=ms, loop=0, optimize=False, disposal=1)
    print(out)


if __name__ == '__main__':
    main()
