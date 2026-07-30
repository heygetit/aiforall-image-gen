#!/usr/bin/env python3
import argparse
from collections import deque
import json
import math
import os
import statistics
import sys
import tempfile

from PIL import Image, ImageFilter, ImageOps

RESAMPLING = getattr(Image, "Resampling", Image)
MAX_CONNECTIVITY_EDGE = 512


def inspect_image(path):
    with Image.open(path) as image:
        bands = image.getbands()
        has_alpha = "A" in bands or "transparency" in image.info
        transparent_pixels = 0
        if has_alpha:
            alpha = image.convert("RGBA").getchannel("A")
            histogram = alpha.histogram()
            transparent_pixels = sum(histogram[:255])
        return {
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "format": image.format,
            "has_alpha": has_alpha,
            "transparent_pixels": transparent_pixels,
            "transparent_coverage": transparent_pixels / float(image.width * image.height or 1),
        }


def atomic_save(image, output_path):
    output_path = os.path.abspath(output_path)
    output_dir = os.path.dirname(output_path)
    os.makedirs(output_dir, exist_ok=True)
    suffix = os.path.splitext(output_path)[1].lower() or ".png"
    handle, temp_path = tempfile.mkstemp(prefix=".aiforall-image-", suffix=suffix, dir=output_dir)
    os.close(handle)
    try:
        save_image = image
        if suffix in (".jpg", ".jpeg") and image.mode not in ("RGB", "L"):
            save_image = image.convert("RGB")
        save_image.save(temp_path)
        os.replace(temp_path, output_path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def parse_size(value):
    try:
        width_text, height_text = value.lower().split("x", 1)
        width, height = int(width_text), int(height_text)
    except (TypeError, ValueError):
        raise ValueError("size must be WIDTHxHEIGHT")
    if width <= 0 or height <= 0:
        raise ValueError("size dimensions must be positive")
    return width, height


def resize_image(input_path, output_path, size, mode):
    target = parse_size(size)
    with Image.open(input_path) as source:
        image = source.convert("RGBA") if "A" in source.getbands() else source.convert("RGB")
        if mode == "cover":
            result = ImageOps.fit(image, target, method=RESAMPLING.LANCZOS, centering=(0.5, 0.5))
        elif mode == "contain":
            result = ImageOps.contain(image, target, method=RESAMPLING.LANCZOS)
        else:
            result = image.resize(target, RESAMPLING.LANCZOS)
        atomic_save(result, output_path)
    return inspect_image(output_path)


def parse_hex_color(value):
    text = value.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError("key color must be a six-digit hex color")
    return tuple(int(text[index:index + 2], 16) for index in (0, 2, 4))


def color_distance(left, right):
    return math.sqrt(sum((left[index] - right[index]) ** 2 for index in range(3)))


def percentile(values, fraction):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[int(round((len(ordered) - 1) * fraction))]


def border_pixels(image, thickness):
    width, height = image.size
    pixels = image.load()
    result = []
    for y in range(height):
        for x in range(width):
            if x < thickness or y < thickness or x >= width - thickness or y >= height - thickness:
                result.append(pixels[x, y][:3])
    return result


def connected_background_mask(image, background, threshold):
    preview = image.copy()
    preview.thumbnail((MAX_CONNECTIVITY_EDGE, MAX_CONNECTIVITY_EDGE), RESAMPLING.LANCZOS)
    width, height = preview.size
    pixels = preview.load()
    candidates = bytearray(width * height)
    for y in range(height):
        row = y * width
        for x in range(width):
            if color_distance(pixels[x, y][:3], background) <= threshold:
                candidates[row + x] = 1

    connected = bytearray(width * height)
    queue = deque()

    def seed(x, y):
        index = y * width + x
        if candidates[index] and not connected[index]:
            connected[index] = 1
            queue.append(index)

    for x in range(width):
        seed(x, 0)
        seed(x, height - 1)
    for y in range(height):
        seed(0, y)
        seed(width - 1, y)

    while queue:
        index = queue.popleft()
        x = index % width
        y = index // width
        if x > 0:
            seed(x - 1, y)
        if x + 1 < width:
            seed(x + 1, y)
        if y > 0:
            seed(x, y - 1)
        if y + 1 < height:
            seed(x, y + 1)

    mask = Image.frombytes("L", (width, height), bytes(255 if value else 0 for value in connected))
    return mask.resize(image.size, RESAMPLING.BILINEAR)


def smoothstep(value):
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def validate_transparency(image):
    rgba = image.convert("RGBA")
    width, height = rgba.size
    alpha = rgba.getchannel("A")
    histogram = alpha.histogram()
    total = width * height or 1
    transparent_coverage = sum(histogram[:255]) / float(total)
    opaque_coverage = histogram[255] / float(total)
    border_width = max(1, min(width, height) // 100)
    border_alpha = border_pixels(rgba, border_width)
    border_values = []
    pixels = rgba.load()
    for y in range(height):
        for x in range(width):
            if x < border_width or y < border_width or x >= width - border_width or y >= height - border_width:
                border_values.append(pixels[x, y][3])
    transparent_border_ratio = sum(1 for value in border_values if value <= 16) / float(len(border_values) or 1)
    mean_border_alpha = sum(border_values) / float(len(border_values) or 1)
    valid = (
        0.01 <= transparent_coverage <= 0.97
        and opaque_coverage >= 0.01
        and transparent_border_ratio >= 0.90
        and mean_border_alpha <= 24.0
    )
    return {
        "valid_alpha": valid,
        "transparent_coverage": transparent_coverage,
        "opaque_coverage": opaque_coverage,
        "transparent_border_ratio": transparent_border_ratio,
        "mean_border_alpha": mean_border_alpha,
    }


def chroma_image(args):
    requested_key = parse_hex_color(args.key_color)
    with Image.open(args.input) as source:
        image = source.convert("RGBA")
        sample_image = image.copy()
        sample_image.thumbnail((MAX_CONNECTIVITY_EDGE, MAX_CONNECTIVITY_EDGE), RESAMPLING.LANCZOS)
        samples = border_pixels(sample_image, max(2, min(sample_image.size) // 64))
        sampled_key = tuple(int(statistics.median(channel)) for channel in zip(*samples)) if samples else requested_key
        deviations = [color_distance(pixel, sampled_key) for pixel in samples]
        background_threshold = max(56.0, min(120.0, percentile(deviations, 0.99) + 48.0))
        opaque_threshold = max(background_threshold + 28.0, float(args.opaque_threshold))
        connected = connected_background_mask(image, sampled_key, background_threshold)
        connected_pixels = connected.load()
        pixels = list(image.getdata())
        output = []
        width, height = image.size
        for index, (red, green, blue, original_alpha) in enumerate(pixels):
            x = index % width
            y = index // width
            connectivity = connected_pixels[x, y] / 255.0
            if connectivity <= 0.02:
                matte = 1.0
            elif connectivity >= 0.98:
                matte = 0.0
            else:
                distance = color_distance((red, green, blue), sampled_key)
                low = max(float(args.transparent_threshold), background_threshold * 0.45)
                color_matte = smoothstep((distance - low) / max(1.0, opaque_threshold - low))
                matte = min(1.0 - connectivity, color_matte)
            alpha = int(round(original_alpha * matte))
            if args.despill and matte < 1.0:
                if requested_key[1] >= requested_key[0] and requested_key[1] >= requested_key[2]:
                    green = min(green, int(max(red, blue) + (green - max(red, blue)) * matte))
                elif requested_key[0] >= requested_key[1] and requested_key[0] >= requested_key[2]:
                    red = min(red, int(max(green, blue) + (red - max(green, blue)) * matte))
                else:
                    blue = min(blue, int(max(red, green) + (blue - max(red, green)) * matte))
            output.append((red, green, blue, alpha))
        image.putdata(output)
        if args.edge_contract > 0:
            alpha = image.getchannel("A")
            kernel = args.edge_contract * 2 + 1
            alpha = alpha.filter(ImageFilter.MinFilter(kernel))
            image.putalpha(alpha)
        validation = validate_transparency(image)
        if not validation["valid_alpha"]:
            raise ValueError("adaptive chroma validation failed: " + json.dumps(validation, ensure_ascii=True))
        atomic_save(image, args.output)

    metadata = inspect_image(args.output)
    metadata.update(validation)
    metadata["sampled_key"] = "#%02x%02x%02x" % sampled_key
    metadata["background_threshold"] = background_threshold
    metadata["method"] = "adaptive-chroma"
    return metadata


def rembg_image(args):
    try:
        from rembg import new_session, remove
    except ImportError:
        raise RuntimeError('rembg[cpu] is not installed; run: pip install "rembg[cpu]"')

    with Image.open(args.input) as source:
        image = source.convert("RGBA")
        session = new_session(args.model)
        result = remove(image, session=session)
        if not isinstance(result, Image.Image):
            raise RuntimeError("rembg returned an unsupported result")
        result = result.convert("RGBA")
        validation = validate_transparency(result)
        if not validation["valid_alpha"]:
            raise ValueError("rembg validation failed: " + json.dumps(validation, ensure_ascii=True))
        atomic_save(result, args.output)

    metadata = inspect_image(args.output)
    metadata.update(validation)
    metadata["method"] = "rembg"
    metadata["rembg_model"] = args.model
    return metadata


def build_parser():
    parser = argparse.ArgumentParser(description="aiforall-image-gen Pillow helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--input", required=True)

    resize_parser = subparsers.add_parser("resize")
    resize_parser.add_argument("--input", required=True)
    resize_parser.add_argument("--output", required=True)
    resize_parser.add_argument("--size", required=True)
    resize_parser.add_argument("--mode", choices=("cover", "contain", "stretch"), default="cover")

    chroma_parser = subparsers.add_parser("chroma")
    chroma_parser.add_argument("--input", required=True)
    chroma_parser.add_argument("--output", required=True)
    chroma_parser.add_argument("--key-color", default="#00ff00")
    chroma_parser.add_argument("--transparent-threshold", type=int, default=12)
    chroma_parser.add_argument("--opaque-threshold", type=int, default=220)
    chroma_parser.add_argument("--edge-contract", type=int, default=0)
    chroma_parser.add_argument("--despill", action="store_true")

    rembg_parser = subparsers.add_parser("rembg")
    rembg_parser.add_argument("--input", required=True)
    rembg_parser.add_argument("--output", required=True)
    rembg_parser.add_argument("--model", default="u2net")
    return parser


def main():
    args = build_parser().parse_args()
    if args.command == "inspect":
        result = inspect_image(args.input)
    elif args.command == "resize":
        result = resize_image(args.input, args.output, args.size, args.mode)
    elif args.command == "chroma":
        result = chroma_image(args)
    else:
        result = rembg_image(args)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
