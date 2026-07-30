import json
import os
import subprocess
import sys
import tempfile
import unittest

from PIL import Image


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TOOL = os.path.join(ROOT, "plugins", "aiforall-image-gen", "scripts", "image_tools.py")


class ImageToolsTests(unittest.TestCase):
    def run_tool(self, *args, **kwargs):
        result = subprocess.run(
            [sys.executable, TOOL] + list(args),
            check=True,
            capture_output=True,
            text=True,
            env=kwargs.get("env"),
        )
        return json.loads(result.stdout)

    def test_resize_cover_writes_exact_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.png")
            output = os.path.join(directory, "output.png")
            Image.new("RGB", (80, 80), (10, 20, 30)).save(source)
            metadata = self.run_tool("resize", "--input", source, "--output", output, "--size", "128x64", "--mode", "cover")
            self.assertEqual((metadata["width"], metadata["height"]), (128, 64))

    def test_chroma_removal_preserves_subject_and_clears_corners(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.png")
            output = os.path.join(directory, "output.png")
            image = Image.new("RGB", (64, 64), (0, 255, 0))
            for x in range(16, 48):
                for y in range(16, 48):
                    image.putpixel((x, y), (220, 20, 20))
            image.save(source)
            metadata = self.run_tool(
                "chroma", "--input", source, "--output", output,
                "--key-color", "#00ff00", "--transparent-threshold", "12",
                "--opaque-threshold", "220", "--edge-contract", "1", "--despill",
            )
            result = Image.open(output).convert("RGBA")
            self.assertEqual(result.getpixel((0, 0))[3], 0)
            self.assertGreater(result.getpixel((32, 32))[3], 240)
            self.assertTrue(metadata["has_alpha"])
            self.assertGreater(metadata["transparent_coverage"], 0.5)

    def test_adaptive_chroma_handles_textured_background_and_preserves_disconnected_color(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.png")
            output = os.path.join(directory, "output.png")
            image = Image.new("RGB", (96, 96))
            for y in range(96):
                for x in range(96):
                    texture = (x * 7 + y * 11) % 30
                    image.putpixel((x, y), (15 + texture // 3, 42 + texture, 22 + texture // 2))
            for x in range(22, 74):
                for y in range(20, 76):
                    image.putpixel((x, y), (220, 20, 20))
            for x in range(42, 54):
                for y in range(42, 54):
                    image.putpixel((x, y), (20, 60, 30))
            image.save(source)

            metadata = self.run_tool(
                "chroma", "--input", source, "--output", output,
                "--key-color", "#00ff00", "--transparent-threshold", "12",
                "--opaque-threshold", "220", "--edge-contract", "1", "--despill",
            )
            result = Image.open(output).convert("RGBA")
            self.assertEqual(result.getpixel((0, 0))[3], 0)
            self.assertGreater(result.getpixel((30, 30))[3], 240)
            self.assertGreater(result.getpixel((48, 48))[3], 240)
            self.assertEqual(metadata["method"], "adaptive-chroma")
            self.assertGreaterEqual(metadata["transparent_border_ratio"], 0.99)

    def test_rembg_subcommand_uses_selected_model_and_validates_alpha(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.png")
            output = os.path.join(directory, "output.png")
            package = os.path.join(directory, "rembg")
            os.makedirs(package)
            with open(os.path.join(package, "__init__.py"), "w", encoding="utf8") as handle:
                handle.write(
                    "from PIL import Image, ImageDraw\n"
                    "def new_session(name): return name\n"
                    "def remove(image, session=None):\n"
                    "    result=image.convert('RGBA')\n"
                    "    alpha=Image.new('L', result.size, 0)\n"
                    "    ImageDraw.Draw(alpha).rectangle((16,16,47,47), fill=255)\n"
                    "    result.putalpha(alpha)\n"
                    "    return result\n"
                )
            Image.new("RGB", (64, 64), (180, 180, 180)).save(source)
            env = dict(os.environ)
            env["PYTHONPATH"] = directory + os.pathsep + env.get("PYTHONPATH", "")
            metadata = self.run_tool(
                "rembg", "--input", source, "--output", output, "--model", "u2net",
                env=env,
            )
            self.assertEqual(metadata["method"], "rembg")
            self.assertEqual(metadata["rembg_model"], "u2net")
            self.assertEqual(Image.open(output).convert("RGBA").getpixel((0, 0))[3], 0)


if __name__ == "__main__":
    unittest.main()
