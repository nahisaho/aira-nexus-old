import ast
import base64
import hashlib
import json
import os
import queue
import re
import stat
import subprocess
import sys
import time
import uuid

from jupyter_client import KernelManager

from protocol import (
    ACK_SECONDS, CHUNK_LIMIT, DISPLAY_LIMIT, EMPTY_HASH, FILE_LIMIT, FRAME_LIMIT,
    PHASE_SECONDS, TOTAL_LIMIT, Channel, ProtocolError, check_deadline, decode,
    decode_chunk, digest, encode, fail, fields, identifier, integer, safe_name,
)


WORKSPACE = "/workspace"
OPEN_READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_nlink)


def regular(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail(409, "UNSAFE_OUTPUT_FILE")
    integer(info.st_size, FILE_LIMIT)


class Outputs:
    def __init__(self):
        self.values = []
        self.displays = {}
        self.clear_pending = False
        self.error_seen = False
        self.display_bytes = 0

    def serialized(self):
        raw = encode({"outputs": self.values})
        if len(raw) > DISPLAY_LIMIT:
            fail(413, "DISPLAY_TOO_LARGE")
        return raw

    def collect(self, kind, content):
        if kind == "clear_output":
            fields(content, ("wait",))
            if type(content["wait"]) is not bool:
                fail(503, "JUPYTER_PROTOCOL")
            if content["wait"]:
                self.clear_pending = True
            else:
                self.values.clear()
                self.displays.clear()
                self.display_bytes = 0
                self.clear_pending = False
            return
        if kind not in ("stream", "error", "display_data", "execute_result",
                        "update_display_data"):
            return
        if len(encode(content)) > DISPLAY_LIMIT:
            fail(413, "DISPLAY_TOO_LARGE")
        if self.clear_pending:
            self.values.clear()
            self.displays.clear()
            self.display_bytes = 0
            self.clear_pending = False
        if kind == "stream":
            if content.get("name") not in ("stdout", "stderr") or type(content.get("text")) is not str:
                fail(503, "JUPYTER_PROTOCOL")
            output = {"output_type": "stream", "name": content["name"], "text": content["text"]}
            if (self.values and self.values[-1]["output_type"] == "stream"
                    and self.values[-1]["name"] == output["name"]):
                self.values[-1]["text"] += output["text"]
            else:
                self.values.append(output)
        elif kind == "error":
            if (type(content.get("ename")) is not str or type(content.get("evalue")) is not str
                    or type(content.get("traceback")) is not list
                    or any(type(line) is not str for line in content["traceback"])):
                fail(503, "JUPYTER_PROTOCOL")
            self.error_seen = True
            self.values.append({"output_type": "error", "ename": content["ename"],
                                "evalue": content["evalue"], "traceback": content["traceback"]})
        else:
            if type(content.get("data")) is not dict or type(content.get("metadata", {})) is not dict:
                fail(503, "JUPYTER_PROTOCOL")
            transient = content.get("transient", {})
            if type(transient) is not dict:
                fail(503, "JUPYTER_PROTOCOL")
            display_id = transient.get("display_id")
            if display_id is not None and type(display_id) is not str:
                fail(503, "JUPYTER_PROTOCOL")
            if kind == "update_display_data":
                for output in self.displays.get(display_id, ()):
                    output["data"] = content["data"]
                    output["metadata"] = content.get("metadata", {})
            else:
                output = {"output_type": kind, "data": content["data"],
                          "metadata": content.get("metadata", {})}
                if kind == "execute_result":
                    if type(content.get("execution_count")) is not int:
                        fail(503, "JUPYTER_PROTOCOL")
                    output["execution_count"] = content["execution_count"]
                self.values.append(output)
                if display_id is not None:
                    if display_id not in self.displays:
                        self.display_bytes += len(encode(display_id))
                        if self.display_bytes > DISPLAY_LIMIT:
                            fail(413, "DISPLAY_TOO_LARGE")
                    self.displays.setdefault(display_id, []).append(output)
        self.serialized()


# @id CODE-RUN-WORKER @implements REQ-RUN-001 REQ-RUN-002 REQ-RUN-003 REQ-RUN-004
class Worker:
    def __init__(self, channel):
        self.channel = channel
        self.manifest = None
        self.completed = set()
        self.transfer_ids = set()
        self.staging = None
        self.stage_deadline = None
        self.manager = None
        self.client = None
        self.ready = False
        self.executed = False
        self.inputs_fd = None
        self.partial_fd = None
        self.outputs_fd = None
        self.outputs_identity = None
        self.harvest = None
        self.harvest_completed = set()
        self.harvest_deadline = None
        self.harvesting = None
        self.harvest_ack_deadline = None

    def send(self, request, kind, **values):
        self.channel.send({"id": request["id"], "kind": kind, **values},
                          self.phase_deadline())

    def phase_deadline(self):
        if self.stage_deadline is not None:
            return self.stage_deadline
        return self.harvest_deadline

    def transfer_id(self, value):
        identifier(value)
        if value in self.transfer_ids:
            fail(409, "TRANSFER_ID_REUSED")
        self.transfer_ids.add(value)
        return value

    def begin_stage(self, request):
        fields(request, ("id", "kind", "files"))
        if self.manifest is not None or self.ready:
            fail(409, "INVALID_STATE")
        if type(request["files"]) is not list:
            fail(400, "INVALID_MANIFEST")
        manifest = {}
        total = 0
        for item in request["files"]:
            fields(item, ("id", "name", "size", "sha256"))
            identifier(item["id"])
            name = safe_name(item["name"])
            integer(item["size"], FILE_LIMIT)
            digest(item["sha256"])
            if name in manifest:
                fail(409, "DUPLICATE_NAME")
            total += item["size"]
            if total > TOTAL_LIMIT:
                fail(413, "CAPACITY_EXCEEDED")
            manifest[name] = dict(item)
        self.manifest = manifest
        self.stage_deadline = time.monotonic() + PHASE_SECONDS if manifest else None
        os.mkdir(WORKSPACE + "/inputs", 0o700)
        os.mkdir(WORKSPACE + "/.aira-stage", 0o700)
        os.mkdir(WORKSPACE + "/outputs", 0o700)
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        self.inputs_fd = os.open(WORKSPACE + "/inputs", directory_flags)
        self.partial_fd = os.open(WORKSPACE + "/.aira-stage", directory_flags)
        self.outputs_fd = os.open(WORKSPACE + "/outputs", directory_flags)
        self.outputs_identity = identity(os.fstat(self.outputs_fd))[:2]
        self.send(request, "ack")

    def begin_file(self, request):
        fields(request, ("id", "kind", "transferId", "fileId", "name", "size", "sha256"))
        if self.manifest is None or self.ready or self.staging is not None:
            fail(409, "INVALID_STATE")
        name = safe_name(request["name"])
        identifier(request["fileId"])
        integer(request["size"], FILE_LIMIT)
        digest(request["sha256"])
        expected = self.manifest.get(name)
        if (expected is None or name in self.completed
                or any(request[key] != expected[field] for key, field in (
                    ("fileId", "id"), ("size", "size"), ("sha256", "sha256")))):
            fail(409, "MANIFEST_MISMATCH")
        transfer_id = self.transfer_id(request["transferId"])
        partial = transfer_id + ".partial"
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.partial_fd)
        self.staging = {"id": transfer_id, "fd": fd, "partial": partial,
                        "entry": expected, "offset": 0, "hash": hashlib.sha256()}
        self.send(request, "ack", transferId=transfer_id, offset=0, sha256=EMPTY_HASH)

    def stage_chunk(self, request):
        fields(request, ("id", "kind", "transferId", "offset", "data", "sha256"))
        transfer = self.require_staging(request)
        integer(request["offset"])
        digest(request["sha256"])
        if request["offset"] != transfer["offset"]:
            fail(409, "OFFSET_MISMATCH")
        raw = decode_chunk(request["data"])
        sha256 = hashlib.sha256(raw).hexdigest()
        if sha256 != request["sha256"]:
            fail(409, "CHECKSUM_MISMATCH")
        if transfer["offset"] + len(raw) > transfer["entry"]["size"]:
            fail(413, "FILE_SIZE_EXCEEDED")
        view = memoryview(raw)
        while view:
            check_deadline(self.stage_deadline)
            written = os.write(transfer["fd"], view)
            if written <= 0:
                fail(503, "FILE_IO")
            view = view[written:]
        transfer["hash"].update(raw)
        transfer["offset"] += len(raw)
        self.send(request, "ack", transferId=transfer["id"], offset=transfer["offset"],
                  sha256=sha256)

    def require_staging(self, request):
        identifier(request["transferId"])
        if self.staging is None or request["transferId"] != self.staging["id"]:
            fail(409, "TRANSFER_MISMATCH")
        return self.staging

    def end_file(self, request):
        fields(request, ("id", "kind", "transferId", "size", "sha256"))
        transfer = self.require_staging(request)
        integer(request["size"], FILE_LIMIT)
        digest(request["sha256"])
        entry = transfer["entry"]
        if (request["size"] != entry["size"] or transfer["offset"] != entry["size"]
                or request["sha256"] != entry["sha256"]
                or transfer["hash"].hexdigest() != entry["sha256"]
                or os.fstat(transfer["fd"]).st_size != entry["size"]):
            fail(409, "FINAL_CHECKSUM_MISMATCH")
        os.fchmod(transfer["fd"], 0o400)
        os.close(transfer["fd"])
        transfer["fd"] = None
        # Reserve the destination exclusively; no kernel exists during staging.
        target = os.open(entry["name"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o400, dir_fd=self.inputs_fd)
        os.close(target)
        os.replace(transfer["partial"], entry["name"],
                   src_dir_fd=self.partial_fd, dst_dir_fd=self.inputs_fd)
        self.completed.add(entry["name"])
        self.staging = None
        self.send(request, "ack", transferId=transfer["id"], offset=entry["size"],
                  sha256=entry["sha256"])
        if len(self.completed) == len(self.manifest):
            self.stage_deadline = None

    def kernel_execute(self, code, request=None, expressions=None):
        deadline = time.monotonic() + 30
        message_id = self.client.execute(code, allow_stdin=False, stop_on_error=True,
                                         store_history=False, user_expressions=expressions or {})
        outputs = Outputs()
        reply = None
        idle = False
        started = False
        while reply is None or not idle:
            check_deadline(deadline)
            if not self.manager.is_alive():
                fail(503, "KERNEL_DIED")
            try:
                message = self.client.get_iopub_msg(timeout=min(0.05, max(0, deadline - time.monotonic())))
            except queue.Empty:
                message = None
            if message is not None and message.get("parent_header", {}).get("msg_id") == message_id:
                kind = message.get("msg_type")
                content = message.get("content")
                if type(content) is not dict:
                    fail(503, "JUPYTER_PROTOCOL")
                if kind == "execute_input" and not started:
                    started = True
                    if request is not None:
                        self.channel.send({"id": request["id"], "kind": "started"}, deadline)
                elif kind == "status" and content.get("execution_state") == "idle":
                    idle = True
                else:
                    outputs.collect(kind, content)
            try:
                shell = self.client.get_shell_msg(timeout=0)
            except queue.Empty:
                shell = None
            if shell is not None and shell.get("parent_header", {}).get("msg_id") == message_id:
                if shell.get("msg_type") != "execute_reply" or reply is not None:
                    fail(503, "JUPYTER_PROTOCOL")
                reply = shell.get("content")
                if type(reply) is not dict or reply.get("status") not in ("ok", "error", "aborted"):
                    fail(503, "JUPYTER_PROTOCOL")
        check_deadline(deadline)
        if not started:
            fail(503, "JUPYTER_START_NOT_OBSERVED")
        return outputs, reply

    def initialize(self, request):
        fields(request, ("id", "kind", "imageDigest"))
        image_digest = request["imageDigest"]
        if type(image_digest) is not str or re.fullmatch(r"sha256:[0-9a-f]{64}", image_digest) is None:
            fail(400, "INVALID_IMAGE_DIGEST")
        if (self.manifest is None or self.ready or self.staging is not None
                or len(self.completed) != len(self.manifest)):
            fail(409, "STAGING_INCOMPLETE")
        self.manager = KernelManager(kernel_name="python3")
        self.manager.start_kernel(cwd=WORKSPACE, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        self.client = self.manager.client()
        self.client.start_channels()
        self.client.wait_for_ready(timeout=30)
        code = (
            "import typed_bridge as __aira\n"
            "get_ipython().run_line_magic('load_ext', 'rpy2.ipython')\n"
            "import importlib.metadata as __aira_metadata\n"
            "import platform as __aira_platform\n"
            "__aira_environment = {'python': __aira_platform.python_version(), "
            "'r': str(__aira.ro.r('R.version.string')[0]), "
            "'packages': {name: __aira_metadata.version(name) for name in "
            "('numpy', 'pandas', 'rpy2', 'ipykernel', 'IPython', 'jupyter_client', "
            "'matplotlib', 'nbformat')}}\n"
        )
        outputs, reply = self.kernel_execute(
            code, expressions={"environment": "__import__('json').dumps(__aira_environment, allow_nan=False)"})
        if outputs.error_seen or reply["status"] != "ok":
            fail(503, "KERNEL_INITIALIZATION_FAILED")
        expression = reply.get("user_expressions", {}).get("environment", {})
        if expression.get("status") != "ok":
            fail(503, "ENVIRONMENT_UNAVAILABLE")
        try:
            serialized = ast.literal_eval(expression["data"]["text/plain"])
        except (KeyError, ValueError, SyntaxError, TypeError, RecursionError):
            fail(503, "ENVIRONMENT_UNAVAILABLE")
        if type(serialized) is not str:
            fail(503, "ENVIRONMENT_UNAVAILABLE")
        environment = decode(serialized.encode("utf-8"))
        fields(environment, ("python", "r", "packages"))
        if (type(environment["python"]) is not str or type(environment["r"]) is not str
                or type(environment["packages"]) is not dict
                or any(type(version) is not str for version in environment["packages"].values())):
            fail(503, "ENVIRONMENT_UNAVAILABLE")
        environment["imageDigest"] = image_digest
        self.ready = True
        self.send(request, "ready", environment=environment)

    def execute(self, request):
        fields(request, ("id", "kind", "source", "language", "sharing"))
        if not self.ready or self.harvest_deadline is not None:
            fail(409, "INVALID_STATE")
        if type(request["source"]) is not str or request["language"] not in ("python", "r"):
            fail(400, "INVALID_CELL")
        if type(request["sharing"]) is not list:
            fail(400, "INVALID_SHARING")
        for entry in request["sharing"]:
            fields(entry, ("name", "direction"), ("family",))
            if (type(entry["name"]) is not str or not entry["name"] or "\0" in entry["name"]
                    or entry["direction"] not in ("python-to-r", "r-to-python")
                    or ("family" in entry and entry["family"] not in ("scalar", "array", "table"))):
                fail(400, "INVALID_SHARING")
        sharing = json.dumps(request["sharing"], ensure_ascii=True, allow_nan=False)
        code = ("__aira.run_cell(" + repr(request["source"]) + ", " + repr(request["language"])
                + ", __import__('json').loads(" + repr(sharing) + "))")
        outputs, reply = self.kernel_execute(code, request)
        self.executed = True
        self.harvest = None
        raw = outputs.serialized()
        status = "error" if outputs.error_seen or reply["status"] != "ok" else "ok"
        transfer_id = str(uuid.uuid4())
        sha256 = hashlib.sha256(raw).hexdigest()
        deadline = time.monotonic() + PHASE_SECONDS
        self.channel.send({"id": request["id"], "kind": "result-begin", "transferId": transfer_id,
                           "size": len(raw), "sha256": sha256, "status": status}, deadline)
        for offset in range(0, len(raw), CHUNK_LIMIT):
            part = raw[offset:offset + CHUNK_LIMIT]
            chunk_hash = hashlib.sha256(part).hexdigest()
            ack_deadline = min(deadline, time.monotonic() + ACK_SECONDS)
            self.channel.send({"id": request["id"], "kind": "result-chunk", "transferId": transfer_id,
                               "offset": offset, "data": base64.b64encode(part).decode("ascii"),
                               "sha256": chunk_hash}, ack_deadline)
            self.channel.expect_ack(request["id"], transfer_id, offset + len(part),
                                    chunk_hash, ack_deadline)
        ack_deadline = min(deadline, time.monotonic() + ACK_SECONDS)
        self.channel.send({"id": request["id"], "kind": "result-end", "transferId": transfer_id,
                           "size": len(raw), "sha256": sha256}, ack_deadline)
        self.channel.expect_ack(request["id"], transfer_id, len(raw), sha256, ack_deadline)

    def check_output_directory(self):
        info = os.stat(WORKSPACE + "/outputs", follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or identity(info)[:2] != self.outputs_identity:
            fail(409, "OUTPUT_DIRECTORY_CHANGED")

    def hash_file(self, fd, deadline):
        value = hashlib.sha256()
        offset = 0
        while True:
            check_deadline(deadline)
            part = os.pread(fd, CHUNK_LIMIT, offset)
            if not part:
                break
            offset += len(part)
            if offset > FILE_LIMIT:
                fail(413, "FILE_SIZE_EXCEEDED")
            value.update(part)
        return offset, value.hexdigest()

    def check_file(self, fd, entry):
        self.check_output_directory()
        info = os.fstat(fd)
        regular(info)
        named = os.stat(entry["name"], dir_fd=self.outputs_fd, follow_symlinks=False)
        if identity(info) != entry["identity"] or identity(named) != entry["identity"]:
            fail(409, "OUTPUT_FILE_CHANGED")

    def harvest_list(self, request):
        fields(request, ("id", "kind"))
        if not self.ready or not self.executed or self.harvest_deadline is not None:
            fail(409, "INVALID_STATE")
        self.check_output_directory()
        self.harvest_deadline = time.monotonic() + PHASE_SECONDS
        self.harvest = {}
        self.harvest_completed = set()
        files = []
        total = 0
        encoded_size = len(encode({"id": request["id"], "kind": "manifest", "files": []})) + 1
        with os.scandir(self.outputs_fd) as entries:
            for item in entries:
                check_deadline(self.harvest_deadline)
                name = safe_name(item.name)
                fd = os.open(name, OPEN_READ, dir_fd=self.outputs_fd)
                try:
                    info = os.fstat(fd)
                    regular(info)
                    total += info.st_size
                    if total > TOTAL_LIMIT:
                        fail(413, "CAPACITY_EXCEEDED")
                    snapshot = {"name": name, "identity": identity(info)}
                    size, sha256 = self.hash_file(fd, self.harvest_deadline)
                    self.check_file(fd, snapshot)
                    if size != info.st_size:
                        fail(409, "OUTPUT_FILE_CHANGED")
                finally:
                    os.close(fd)
                transfer_id = str(uuid.uuid4())
                entry = {"name": name, "size": size, "sha256": sha256, "transferId": transfer_id}
                encoded_size += len(encode(entry)) + (1 if files else 0)
                if encoded_size > FRAME_LIMIT:
                    fail(413, "MANIFEST_TOO_LARGE")
                files.append(entry)
                self.harvest[transfer_id] = {**entry, "identity": snapshot["identity"]}
        self.check_output_directory()
        self.send(request, "manifest", files=files)
        if not files:
            self.harvest_deadline = None

    def harvest_open(self, request):
        fields(request, ("id", "kind", "transferId"))
        identifier(request["transferId"])
        if (self.harvest is None or self.harvesting is not None or self.harvest_deadline is None
                or request["transferId"] not in self.harvest
                or request["transferId"] in self.harvest_completed):
            fail(409, "INVALID_STATE")
        entry = self.harvest[request["transferId"]]
        fd = os.open(entry["name"], OPEN_READ, dir_fd=self.outputs_fd)
        try:
            self.check_file(fd, entry)
        except BaseException:
            os.close(fd)
            raise
        self.harvesting = {"entry": entry, "fd": fd, "offset": 0,
                           "hash": hashlib.sha256(), "pending": None}
        self.send(request, "ack", transferId=entry["transferId"], offset=0, sha256=EMPTY_HASH)

    def require_harvest(self, request):
        identifier(request["transferId"])
        if self.harvesting is None or request["transferId"] != self.harvesting["entry"]["transferId"]:
            fail(409, "TRANSFER_MISMATCH")
        return self.harvesting

    def harvest_read(self, request):
        fields(request, ("id", "kind", "transferId", "offset"))
        transfer = self.require_harvest(request)
        integer(request["offset"])
        entry = transfer["entry"]
        if transfer["pending"] is not None:
            fail(409, "ACK_REQUIRED")
        if request["offset"] != transfer["offset"] or transfer["offset"] >= entry["size"]:
            fail(409, "OFFSET_MISMATCH")
        self.check_file(transfer["fd"], entry)
        raw = os.pread(transfer["fd"], min(CHUNK_LIMIT, entry["size"] - transfer["offset"]),
                       transfer["offset"])
        self.check_file(transfer["fd"], entry)
        if not raw:
            fail(409, "OUTPUT_FILE_CHANGED")
        sha256 = hashlib.sha256(raw).hexdigest()
        transfer["hash"].update(raw)
        transfer["pending"] = (transfer["offset"] + len(raw), sha256)
        self.harvest_ack_deadline = min(self.harvest_deadline, time.monotonic() + ACK_SECONDS)
        self.channel.send({"id": request["id"], "kind": "chunk", "transferId": entry["transferId"],
                           "offset": transfer["offset"], "data": base64.b64encode(raw).decode("ascii"),
                           "sha256": sha256}, self.harvest_ack_deadline)

    def harvest_ack(self, request):
        fields(request, ("id", "kind", "transferId", "offset", "sha256"))
        transfer = self.require_harvest(request)
        integer(request["offset"])
        digest(request["sha256"])
        if transfer["pending"] != (request["offset"], request["sha256"]):
            fail(409, "ACK_MISMATCH")
        transfer["offset"] = request["offset"]
        transfer["pending"] = None
        self.harvest_ack_deadline = None
        self.send(request, "ack", transferId=request["transferId"], offset=request["offset"],
                  sha256=request["sha256"])

    def harvest_end(self, request):
        fields(request, ("id", "kind", "transferId"))
        transfer = self.require_harvest(request)
        entry = transfer["entry"]
        if transfer["pending"] is not None or transfer["offset"] != entry["size"]:
            fail(409, "TRANSFER_INCOMPLETE")
        self.check_file(transfer["fd"], entry)
        size, sha256 = self.hash_file(transfer["fd"], self.harvest_deadline)
        self.check_file(transfer["fd"], entry)
        if (size != entry["size"] or sha256 != entry["sha256"]
                or transfer["hash"].hexdigest() != entry["sha256"]):
            fail(409, "FINAL_CHECKSUM_MISMATCH")
        os.close(transfer["fd"])
        self.harvesting = None
        self.harvest_completed.add(entry["transferId"])
        self.send(request, "file-end", transferId=entry["transferId"], size=size, sha256=sha256)
        if len(self.harvest_completed) == len(self.harvest):
            self.harvest_deadline = None

    def run(self):
        self.channel.send({"kind": "hello", "version": 1})
        handlers = {
            "stage-begin": self.begin_stage, "file-begin": self.begin_file,
            "file-chunk": self.stage_chunk, "file-end": self.end_file,
            "initialize": self.initialize, "execute": self.execute,
            "harvest-list": self.harvest_list, "harvest-open": self.harvest_open,
            "harvest-read": self.harvest_read, "harvest-ack": self.harvest_ack,
            "harvest-end": self.harvest_end,
        }
        while True:
            deadline = self.phase_deadline()
            if self.staging is not None:
                deadline = min(deadline, time.monotonic() + ACK_SECONDS)
            if self.harvest_ack_deadline is not None:
                deadline = self.harvest_ack_deadline
            request = self.channel.receive(deadline)
            if self.staging is not None and request["kind"] not in ("file-chunk", "file-end"):
                fail(409, "TRANSFER_IN_PROGRESS")
            if self.harvest_ack_deadline is not None and request["kind"] != "harvest-ack":
                fail(409, "ACK_REQUIRED")
            handler = handlers.get(request["kind"])
            if handler is None:
                fail(400, "INVALID_KIND")
            handler(request)

    def close(self):
        try:
            if self.client is not None:
                self.client.stop_channels()
        finally:
            if self.manager is not None and self.manager.has_kernel:
                self.manager.shutdown_kernel(now=True)
        if self.staging is not None:
            if self.staging["fd"] is not None:
                os.close(self.staging["fd"])
            if self.partial_fd is not None:
                try:
                    os.unlink(self.staging["partial"], dir_fd=self.partial_fd)
                except FileNotFoundError:
                    pass
        if self.harvesting is not None:
            os.close(self.harvesting["fd"])
        for fd in (self.inputs_fd, self.partial_fd, self.outputs_fd):
            if fd is not None:
                os.close(fd)


def main():
    channel = Channel()
    worker = Worker(channel)
    exit_code = 0
    try:
        worker.run()
    except EOFError:
        if worker.phase_deadline() is not None:
            exit_code = 1
            report_error(channel, 503, "TRANSPORT_CLOSED")
    except ProtocolError as error:
        exit_code = 1
        report_error(channel, error.status, error.code)
    except (OSError, RuntimeError, TimeoutError, queue.Empty):
        exit_code = 1
        report_error(channel, 503, "RUNTIME_IO")
    except Exception:
        exit_code = 1
        print("Runtime worker failed.", file=sys.stderr, flush=True)
        report_error(channel, 503, "INTERNAL_FAILURE")
    finally:
        try:
            worker.close()
        except Exception:
            exit_code = 1
            print("Runtime shutdown failed.", file=sys.stderr, flush=True)
    return exit_code


def report_error(channel, status, code):
    try:
        channel.send({"id": channel.current_id, "kind": "error", "status": status, "code": code})
    except (OSError, ProtocolError):
        print("Runtime transport failed.", file=sys.stderr, flush=True)


if __name__ == "__main__":
    sys.exit(main())
