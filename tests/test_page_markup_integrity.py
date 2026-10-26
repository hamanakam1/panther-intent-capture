"""Every extension page must be one unambiguous document.

A browser repairs a malformed page instead of refusing it. Markup that sits
after the closing ``</html>`` tag is folded back into the body, and an element
id that appears twice leaves the second copy unreachable: ``getElementById``
returns the first one, so a script updates a control the reader cannot see.

The status window shipped exactly that shape for several releases. It carried a
stale copy of four sections after its closing tag, so the window rendered its
activity, evidence and control sections twice while the script only ever
updated the first copy of each control. The duplicate was invisible in review
because both copies looked correct.

These regressions keep every shipped page a single document with unique ids.
"""

import collections
import re
import unittest
from pathlib import Path

EXTENSION = Path(__file__).resolve().parents[1] / "extension"

OPEN_DOCUMENT = re.compile(r"<html\b", re.IGNORECASE)
CLOSE_DOCUMENT = re.compile(r"</html\s*>", re.IGNORECASE)
ELEMENT_ID = re.compile(r"\bid\s*=\s*\"([^\"]*)\"", re.IGNORECASE)


def pages():
    """Every HTML page the extension ships."""

    return sorted(EXTENSION.rglob("*.html"))


class ExtensionPageMarkupTests(unittest.TestCase):
    def test_every_page_is_a_single_document(self):
        for page in pages():
            with self.subTest(page=page.name):
                text = page.read_text(encoding="utf-8")
                self.assertEqual(1, len(OPEN_DOCUMENT.findall(text)), "page opens <html> more than once")
                self.assertEqual(1, len(CLOSE_DOCUMENT.findall(text)), "page closes </html> more than once")

    def test_no_markup_after_the_closing_document_tag(self):
        for page in pages():
            with self.subTest(page=page.name):
                text = page.read_text(encoding="utf-8")
                tail = text.split("</html>", 1)[1]
                self.assertEqual("", tail.strip(), "the browser would fold this back into the body")

    def test_every_element_id_is_unique_per_page(self):
        for page in pages():
            with self.subTest(page=page.name):
                text = page.read_text(encoding="utf-8")
                counts = collections.Counter(ELEMENT_ID.findall(text))
                repeated = sorted(name for name, count in counts.items() if count > 1)
                self.assertEqual([], repeated, "a repeated id leaves the second copy unreachable")

    def test_the_status_window_has_one_copy_of_each_section(self):
        monitor = EXTENSION / "monitor" / "monitor.html"
        text = monitor.read_text(encoding="utf-8")
        for marker in ("understanding-card", "actions-card", "evidence-card", "session-actions"):
            with self.subTest(section=marker):
                self.assertEqual(1, text.count(f'class="{marker}'), "the status window renders this section twice")


if __name__ == "__main__":
    unittest.main()
