import base64
import binascii
import hashlib
import json
import math
import os
import re
import select
import time
import unicodedata
import uuid


# @id CODE-RUN-PROTOCOL @implements REQ-RUN-003 REQ-RUN-004
FRAME_LIMIT = 1024 * 1024
CHUNK_LIMIT = 512 * 1024
DISPLAY_LIMIT = 2 * 1024 * 1024
FILE_LIMIT = 100 * 1024 * 1024
TOTAL_LIMIT = 256 * 1024 * 1024
PHASE_SECONDS = 120
ACK_SECONDS = 10
EMPTY_HASH = hashlib.sha256(b"").hexdigest()


class ProtocolError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


def fail(status, code):
    raise ProtocolError(status, code)


def check_deadline(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        fail(504, "DEADLINE_EXCEEDED")


def fields(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys():
        fail(400, "INVALID_FIELDS")
    if value.keys() - set(required) - set(optional):
        fail(400, "INVALID_FIELDS")


def identifier(value):
    if type(value) is not str:
        fail(400, "INVALID_UUID")
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        fail(400, "INVALID_UUID")
    if str(parsed) != value:
        fail(400, "INVALID_UUID")
    return value


def digest(value):
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        fail(400, "INVALID_SHA256")
    return value


def integer(value, maximum=None):
    if type(value) is not int or value < 0:
        fail(400, "INVALID_INTEGER")
    if maximum is not None and value > maximum:
        fail(413, "CAPACITY_EXCEEDED")
    return value


def safe_name(value):
    if type(value) is not str:
        fail(400, "INVALID_NAME")
    try:
        length = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        fail(400, "INVALID_NAME")
    if (not 1 <= length <= 240 or unicodedata.normalize("NFC", value) != value
            or value in (".", "..") or value.endswith((".", " "))
            or any(char in "/\\:" or ord(char) <= 0x1F or ord(char) == 0x7F
                   for char in value)):
        fail(400, "INVALID_NAME")
    stem = value.split(".", 1)[0].upper()
    if stem in {"CON", "PRN", "AUX", "NUL"}:
        fail(400, "INVALID_NAME")
    if re.fullmatch(r"(COM|LPT)[1-9]", stem):
        fail(400, "INVALID_NAME")
    return value


def encode(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, UnicodeEncodeError, RecursionError):
        fail(400, "INVALID_JSON")


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail(400, "DUPLICATE_FIELD")
        result[key] = value
    return result


def _invalid_constant(_value):
    fail(400, "INVALID_JSON")


def _finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        fail(400, "INVALID_JSON")
    return result


def decode(raw):
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs,
                          parse_constant=_invalid_constant, parse_float=_finite_float)
    except (ValueError, UnicodeDecodeError, RecursionError):
        fail(400, "INVALID_JSON")


def decode_chunk(value):
    if type(value) is not str or len(value) > 4 * ((CHUNK_LIMIT + 2) // 3):
        fail(413, "CHUNK_TOO_LARGE")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        fail(400, "INVALID_BASE64")
    if not raw or len(raw) > CHUNK_LIMIT:
        fail(413 if raw else 400, "INVALID_CHUNK_SIZE")
    if base64.b64encode(raw).decode("ascii") != value:
        fail(400, "NONCANONICAL_BASE64")
    return raw


class Channel:
    def __init__(self, input_fd=0, output_fd=1):
        self.input_fd = input_fd
        self.output_fd = output_fd
        self.buffer = bytearray()
        self.current_id = None

    def receive(self, deadline=None):
        # Idle reads are intentionally unbounded; only active phases/ACKs expire.
        while True:
            check_deadline(deadline)
            newline = self.buffer.find(b"\n")
            if newline >= 0:
                if newline + 1 > FRAME_LIMIT:
                    fail(413, "FRAME_TOO_LARGE")
                raw = bytes(self.buffer[:newline])
                del self.buffer[:newline + 1]
                value = decode(raw)
                if type(value) is not dict:
                    fail(400, "INVALID_FIELDS")
                self.current_id = identifier(value.get("id"))
                if type(value.get("kind")) is not str:
                    fail(400, "INVALID_KIND")
                return value
            if len(self.buffer) >= FRAME_LIMIT:
                fail(413, "FRAME_TOO_LARGE")
            timeout = None if deadline is None else max(0, deadline - time.monotonic())
            readable, _, _ = select.select([self.input_fd], [], [], timeout)
            if not readable:
                fail(504, "DEADLINE_EXCEEDED")
            part = os.read(self.input_fd, min(65536, FRAME_LIMIT - len(self.buffer)))
            if not part:
                if self.buffer:
                    fail(400, "TRUNCATED_FRAME")
                raise EOFError
            self.buffer.extend(part)

    def send(self, value, deadline=None):
        raw = encode(value) + b"\n"
        if len(raw) > FRAME_LIMIT:
            fail(413, "FRAME_TOO_LARGE")
        if deadline is None:
            deadline = time.monotonic() + ACK_SECONDS
        offset = 0
        while offset < len(raw):
            check_deadline(deadline)
            _, writable, _ = select.select(
                [], [self.output_fd], [], max(0, deadline - time.monotonic()))
            if not writable:
                fail(504, "DEADLINE_EXCEEDED")
            # PIPE_BUF-sized writes cannot block after select reports room.
            count = os.write(self.output_fd, raw[offset:offset + 4096])
            if count <= 0:
                fail(503, "PROTOCOL_IO")
            offset += count

    def expect_ack(self, request_id, transfer_id, offset, sha256, phase_deadline):
        deadline = min(phase_deadline, time.monotonic() + ACK_SECONDS)
        try:
            value = self.receive(deadline)
        except EOFError:
            fail(503, "TRANSPORT_CLOSED")
        fields(value, ("id", "kind", "transferId", "offset", "sha256"))
        identifier(value["transferId"])
        integer(value["offset"])
        digest(value["sha256"])
        if (value["id"] != request_id or value["kind"] != "ack"
                or value["transferId"] != transfer_id or value["offset"] != offset
                or value["sha256"] != sha256):
            fail(409, "ACK_MISMATCH")
