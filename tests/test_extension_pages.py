"""Every extension page must be a single, unambiguous document.

A page that repeats an element id, or that carries markup after its closing
``</html>`` tag, is a page the browser silently repairs: the parser folds the
trailing markup back into the body, so the window renders its sections twice
and the script only ever updates the first copy of each control.

The status window carried exactly that defect for several releases. These
regressions keep every page unambiguous.
"""

import collections
import re
import unittest
from pathlib import Path

EXTENSION = Path(__file__).resolve().parents[1] / "extension"

ID_PATTERN = re.compile(r'id="([^"]+)"')


def pages():
    """Every HTML page the extension ships."""
    return sorted(EXTENSION.rglob("*.html"))


class ExtensionPageMarkupTests(unittest.TestCase):
    def test_every_page_has_unique_element_ids(self):
        for page in pages():
            with self.subTest(page=page.name):
                ids = ID_PATTERN.findall(page.read_text(encoding="utf-8"))
                repeated = {name: count for name, count in collections.Counter(ids).items() if count > 1}
                self.assertEqual(repeated, {}, f"{page.name} repeats element ids")

    def test_no_page_carries_markup_after_its_closing_tag(self):
        for page in pages():
            with self.subTest(page=page.name):
                text = page.read_text(encoding="utf-8")
                end = text.lower().rfind("</html>")
                self.assertNotEqual(end, -1, f"{page.name} has no closing html tag")
                self.assertEqual(
                    text[end + len("</html>") :].strip(),
                    "",
                    f"{page.name} carries markup after </html>; the browser folds it back into the body",
                )

    def test_the_status_window_renders_each_section_once(self):
        text = (EXTENSION / "monitor" / "monitor.html").read_text(encoding="utf-8")
        for section in (
            "Live understanding",
            "Recent captured activity",
            "Captured evidence and results",
            "Session controls",
        ):
            with self.subTest(section=section):
                self.assertEqual(text.count(f'aria-label="{section}"'), 1)

    def test_the_status_window_keeps_its_consent_controls(self):
        text = (EXTENSION / "monitor" / "monitor.html").read_text(encoding="utf-8")
        self.assertIn('id="consent"', text)
        self.assertIn('id="goal"', text)
        self.assertIn('id="startBtn"', text)


if __name__ == "__main__":
    unittest.main()
