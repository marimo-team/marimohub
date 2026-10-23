import os
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb
import pyarrow as pa
from pyiceberg.catalog import load_catalog

from bake_duckdb import BAKED_DIR, EXTENSIONS, install_extensions


assert os.getuid() != 0, "Extension checks must run as the sandbox user"
assert os.environ["HOME"] == "/home/appuser"

cache = Path(BAKED_DIR)
home_extensions = Path.home() / ".duckdb/extensions"
for name in EXTENSIONS:
    assert list(cache.glob(f"*/*/{name}.duckdb_extension")), f"{name} missing from {cache}"
for extension in cache.glob("*/*/*.duckdb_extension"):
    metadata = extension.with_suffix(".duckdb_extension.info")
    assert metadata.is_file(), metadata
    for baked in (extension, metadata):
        linked = home_extensions / baked.relative_to(cache)
        assert linked.is_symlink(), f"Expected a link to the baked cache: {linked}"
        assert linked.resolve() == baked, f"Incorrect cache link: {linked}"

with duckdb.connect() as connection:
    # Reusing the installer also checks that the final status result was drained.
    for _ in range(2):
        install_extensions(connection)

    with TemporaryDirectory() as directory:
        catalog = load_catalog("offline", type="in-memory", warehouse=Path(directory).as_uri())
        catalog.create_namespace("test")
        rows = pa.table({"id": [1, 2, 3]})
        table = catalog.create_table("test.numbers", schema=rows.schema)
        table.append(rows)
        actual = connection.execute(
            "SELECT id FROM iceberg_scan(?) ORDER BY id", [table.metadata_location]
        ).fetchall()
        assert actual == [(1,), (2,), (3,)], actual

print(f"Offline extension checks passed: {', '.join(EXTENSIONS)}; Iceberg scan passed")
