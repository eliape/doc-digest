"""Tiny PDFs built by hand for tests: text pages, pages without text, labels and bookmarks."""


def escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(
    pages: list[list[str]],
    labels: str | None = None,
    bookmarks: list[tuple[str, int]] | None = None,
) -> bytes:
    """
    One page per list of lines (an empty list makes a page with only a drawn
    rectangle, like a scan). `labels` is a raw /PageLabels dictionary.
    Bookmarks are (title, page) pairs.
    """
    objects: list[bytes] = []

    def add(body: str | bytes) -> int:
        objects.append(body.encode("latin-1") if isinstance(body, str) else body)
        return len(objects)

    catalog = add("")  # filled in below
    pages_obj = add("")
    font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    page_ids = []
    for lines in pages:
        if lines:
            ops = ["BT /F1 11 Tf 14 TL 50 790 Td"]
            ops += [f"({escape(line)}) Tj T*" for line in lines]
            ops.append("ET")
        else:
            ops = ["0.2 g 100 300 400 300 re f"]
        stream = "\n".join(ops).encode("latin-1")
        content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        page_ids.append(
            add(
                f"<< /Type /Page /Parent {pages_obj} 0 R /MediaBox [0 0 595 842] "
                f"/Resources << /Font << /F1 {font} 0 R >> >> /Contents {content} 0 R >>"
            )
        )
    kids = " ".join(f"{p} 0 R" for p in page_ids)
    objects[pages_obj - 1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode()

    extra = ""
    if labels:
        extra += f" /PageLabels {labels}"
    if bookmarks:
        outline = add("")
        items = [add("") for _ in bookmarks]
        for i, (title, page) in enumerate(bookmarks):
            links = f"/Parent {outline} 0 R"
            if i > 0:
                links += f" /Prev {items[i - 1]} 0 R"
            if i < len(items) - 1:
                links += f" /Next {items[i + 1]} 0 R"
            objects[items[i] - 1] = (
                f"<< /Title ({escape(title)}) {links} /Dest [{page_ids[page - 1]} 0 R /Fit] >>"
            ).encode()
        objects[outline - 1] = (
            f"<< /Type /Outlines /First {items[0]} 0 R /Last {items[-1]} 0 R /Count {len(items)} >>"
        ).encode()
        extra += f" /Outlines {outline} 0 R"
    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_obj} 0 R{extra} >>".encode()

    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        catalog,
        xref,
    )
    return bytes(out)


def filler(topic: str, n: int = 14) -> list[str]:
    """Enough lines of text about something to count as a text page."""
    return [f"This line is about {topic}, sentence {i} of the discussion." for i in range(n)]
