"""Writes installer/airplay-files.wxs: one MSI component per file of the bundled AirPlay receiver, in its folder.

Listing files explicitly (rather than WiX wildcards) keeps the GStreamer folder layout exactly as bundled.
Usage: python installer/harvest_airplay.py package/airplay installer/airplay-files.wxs
"""
import hashlib
import pathlib
import sys
from xml.sax.saxutils import quoteattr

source = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2])


def ident(prefix, relative):
    return f"{prefix}_{hashlib.sha1(str(relative).lower().encode()).hexdigest()[:20]}"


def directory_xml(folder, indent):
    lines = []
    for child in sorted(path for path in folder.iterdir() if path.is_dir()):
        relative = child.relative_to(source)
        lines.append(f'{indent}<Directory Id="{ident("d", relative)}" Name={quoteattr(child.name)}>')
        lines.extend(directory_xml(child, indent + "  "))
        lines.append(f"{indent}</Directory>")
    return lines


components = []
for path in sorted(source.rglob("*")):
    if not path.is_file():
        continue
    relative = path.relative_to(source)
    if str(relative).lower() == "uxplay.exe":
        continue  # declared in ClassroomBridge.wxs with its firewall rule
    directory = "AIRPLAYFOLDER" if relative.parent == pathlib.Path(".") else ident("d", relative.parent)
    components.append(
        f'      <Component Id="{ident("c", relative)}" Directory="{directory}">'
        f'<File Id="{ident("f", relative)}" Source={quoteattr(str(path))} KeyPath="yes" /></Component>'
    )

output.write_text("\n".join([
    '<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">',
    "  <Fragment>",
    '    <DirectoryRef Id="AIRPLAYFOLDER">',
    *directory_xml(source, "      "),
    "    </DirectoryRef>",
    '    <ComponentGroup Id="AirPlayFiles">',
    *components,
    "    </ComponentGroup>",
    "  </Fragment>",
    "</Wix>",
    "",
]), encoding="utf-8")
print(f"{len(components)} files")
