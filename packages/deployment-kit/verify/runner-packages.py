"""Verify the image manifest against installed distributions, and the WF 115 sandbox."""
import errno
import importlib.metadata
import io
import json
import re
import socket

import pandas as pd
from pypdf import PdfReader, PdfWriter


def key(name):
    return re.sub(r"[-_.]+", "-", name).lower()


with open("/usr/local/share/catalyst/runner-packages.json", encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
assert manifest, "Runner package manifest is empty"
assert len({key(package["name"]) for package in manifest}) == len(manifest)
installed = {key(dist.metadata["Name"]): dist.version for dist in importlib.metadata.distributions()}
assert {key(package["name"]): package["version"] for package in manifest} == installed
for package in manifest:
    assert importlib.metadata.version(package["name"]) == package["version"], package["name"]
assert any(key(package["name"]) == "pypdf" for package in manifest)
assert importlib.metadata.version("pandas") == "2.2.3"
assert any(key(package["name"]) == "pandas" for package in manifest)
assert pd.DataFrame({"amount": [2, 3]}).amount.sum() == 5
pdf = io.BytesIO()
writer = PdfWriter()
writer.add_blank_page(width=72, height=72)
writer.write(pdf)
assert len(PdfReader(pdf).pages) == 1
# Docker --network none may retain inert kernel tunnel interfaces. What matters is that
# there is no route. This documentation-only address must fail before any packet is sent.
with socket.socket() as probe:
    probe.settimeout(1)
    assert probe.connect_ex(("192.0.2.1", 9)) == errno.ENETUNREACH, "Runner has an outbound route"
print(json.dumps({"packages": len(manifest), "pypdf": "imported", "pandas": "imported", "network": "none"}))
