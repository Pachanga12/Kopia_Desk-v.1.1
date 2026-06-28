from __future__ import annotations

import ctypes
import email.parser
import json
import os
import posixpath
import re
from email.policy import HTTP
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


APP_DIR = Path(__file__).resolve().parent
PORT = 4178


def json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def drive_roots() -> list[str]:
    bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    roots: list[str] = []
    for index in range(26):
        if bitmask & (1 << index):
            roots.append(f"{chr(65 + index)}:\\")
    return roots


def volume_label(root: str) -> str:
    name_buffer = ctypes.create_unicode_buffer(261)
    fs_buffer = ctypes.create_unicode_buffer(261)
    serial = ctypes.c_ulong()
    max_component = ctypes.c_ulong()
    flags = ctypes.c_ulong()
    ok = ctypes.windll.kernel32.GetVolumeInformationW(
        ctypes.c_wchar_p(root),
        name_buffer,
        ctypes.sizeof(name_buffer),
        ctypes.byref(serial),
        ctypes.byref(max_component),
        ctypes.byref(flags),
        fs_buffer,
        ctypes.sizeof(fs_buffer),
    )
    return name_buffer.value if ok else ""


def disk_space(root: str) -> tuple[int, int]:
    free = ctypes.c_ulonglong()
    total = ctypes.c_ulonglong()
    total_free = ctypes.c_ulonglong()
    ok = ctypes.windll.kernel32.GetDiskFreeSpaceExW(
        ctypes.c_wchar_p(root),
        ctypes.byref(free),
        ctypes.byref(total),
        ctypes.byref(total_free),
    )
    if not ok:
        return 0, 0
    return int(free.value), int(total.value)


def list_drives() -> list[dict[str, object]]:
    drives: list[dict[str, object]] = []
    for root in drive_roots():
        if not os.path.isdir(root):
            continue
        free, total = disk_space(root)
        drives.append(
            {
                "root": root,
                "label": volume_label(root),
                "free": free,
                "total": total,
            }
        )
    return drives


def safe_target(root: str, relative_path: str) -> Path:
    valid_roots = {drive.upper(): drive for drive in drive_roots()}
    normalized_root = root.upper()
    if normalized_root not in valid_roots:
        raise ValueError("Disco destino no valido.")

    clean = unquote(relative_path).replace("\\", "/")
    clean = posixpath.normpath(clean).lstrip("/")
    if clean == "." or clean.startswith("../") or "/../" in clean:
        raise ValueError("Ruta destino no valida.")

    target = Path(valid_roots[normalized_root]) / Path(*clean.split("/"))
    root_path = Path(valid_roots[normalized_root]).resolve()
    resolved_parent = target.parent.resolve()
    if root_path not in (resolved_parent, *resolved_parent.parents):
        raise ValueError("Ruta fuera del disco destino.")
    return target


class KopiaDeskHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def send_json(self, payload: object, status: int = 200) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, message: str, status: int = 200) -> None:
        body = message.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/api/drives":
            self.send_json(list_drives())
            return
        super().do_GET()

    def do_POST(self) -> None:
        try:
            if self.path == "/api/write-text":
                self.write_text()
                return
            if self.path == "/api/write-file":
                self.write_file()
                return
            if self.path == "/api/read-text":
                self.read_text()
                return
            self.send_text("Ruta no encontrada.", 404)
        except Exception as exc:  # noqa: BLE001 - local app should return clear UI errors.
            self.send_text(str(exc), 400)

    def write_text(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        target = safe_target(str(payload["root"]), str(payload["path"]))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(payload.get("text", "")), encoding="utf-8")
        self.send_json({"ok": True, "path": str(target)})

    def read_text(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        target = safe_target(str(payload["root"]), str(payload["path"]))
        if not target.exists():
            self.send_text("Archivo no encontrado.", 404)
            return
        # If client requests metadata, return JSON with text and modification time
        if payload.get("meta"):
            mtime = target.stat().st_mtime
            text = target.read_text(encoding="utf-8")
            self.send_json({"text": text, "mtime": mtime})
            return
        self.send_text(target.read_text(encoding="utf-8"), 200)

    def write_file(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        form = self.parse_multipart(body, self.headers.get("content-type", ""))
        root = form.get("root")
        relative_path = form.get("path")
        file_item = form.get("file")
        if not root or not relative_path or file_item is None:
            raise ValueError("Solicitud de archivo incompleta.")

        target = safe_target(str(root), str(relative_path))
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as output:
            output.write(file_item["content"])
        self.send_json({"ok": True, "path": str(target)})

    def parse_multipart(self, body: bytes, content_type: str) -> dict[str, object]:
        boundary_match = re.search(r'boundary=(.+)', content_type)
        if not boundary_match:
            raise ValueError("El encabezado Content-Type no contiene boundary.")

        boundary = boundary_match.group(1)
        if boundary.startswith('"') and boundary.endswith('"'):
            boundary = boundary[1:-1]

        message = email.parser.BytesParser(policy=HTTP).parsebytes(
            b"Content-Type: " + content_type.encode("utf-8") + b"\r\n\r\n" + body,
        )

        values: dict[str, object] = {}
        for part in message.iter_parts():
            if part.get_content_disposition() != "form-data":
                continue
            name = part.get_param("name", header="content-disposition")
            if not name:
                continue
            filename = part.get_filename()
            payload = part.get_payload(decode=True) or b""
            if filename:
                values[name] = {
                    "filename": filename,
                    "content": payload,
                    "content_type": part.get_content_type(),
                }
            else:
                charset = part.get_content_charset("utf-8")
                values[name] = payload.decode(charset)

        return values


if __name__ == "__main__":
    os.chdir(APP_DIR)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), KopiaDeskHandler)
    print(f"Kopia Desk listo en http://127.0.0.1:{PORT}/")
    server.serve_forever()
