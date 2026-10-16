import os
import tempfile
from pathlib import Path


def atomic_write_text(path, text: str, encoding: str = "utf-8"):
    """Write via temp file + os.replace so a crash never leaves a truncated file."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding=encoding) as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
