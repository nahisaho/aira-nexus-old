import gc
import math

import numpy as np
import pandas as pd
import rpy2.robjects as ro

# @id CODE-RUN-BRIDGE @implements REQ-RUN-002
schemas = {}
BLOCK = 65536
FAMILIES = {"i": "integer", "u": "integer", "f": "double", "b": "logical", "U": "character"}
EXTENSIONS = {
    "Int8": np.dtype("int8"), "Int16": np.dtype("int16"),
    "Int32": np.dtype("int32"), "Int64": np.dtype("int64"),
    "UInt8": np.dtype("uint8"), "UInt16": np.dtype("uint16"),
    "UInt32": np.dtype("uint32"), "UInt64": np.dtype("uint64"),
    "Float32": np.dtype("float32"), "Float64": np.dtype("float64"),
    "boolean": np.dtype("bool"), "string": np.dtype("U"),
}
ROW_NAMES_BLOCK = ro.r("""function(x, first, last) {
    i <- seq.int(first, last)
    identical(as.character(attr(x, 'row.names')[i]), as.character(i))
}""")


class SharedValueError(ValueError):
    def __init__(self, code):
        super().__init__("Typed sharing rejected: " + code)
        self.code = code


def fail(code):
    raise SharedValueError(code)


def r_dims(value):
    dimensions = ro.r["dim"](value)
    return None if isinstance(dimensions, type(ro.NULL)) else tuple(dimensions)


def r_masks(value):
    missing = np.asarray(ro.r["is.na"](value), dtype=bool).reshape(-1, order="F")
    gc.collect()
    ro.r("gc()")
    nan = np.asarray(ro.r["is.nan"](value), dtype=bool).reshape(-1, order="F")
    missing &= ~nan
    gc.collect()
    ro.r("gc()")
    return missing, nan


def check_attrs(value, allowed):
    names = ro.r["names"](ro.r["attributes"](value))
    actual = set() if isinstance(names, type(ro.NULL)) else set(names)
    if not actual <= allowed:
        fail("R_METADATA")


def default_index(value):
    if not isinstance(value.index, pd.RangeIndex) or value.index.name is not None:
        fail("INDEX_METADATA")
    if (value.index.start, value.index.stop, value.index.step) != (0, len(value), 1):
        fail("INDEX_METADATA")
    if value.attrs:
        fail("USER_ATTRIBUTES")


def describe(value):
    if isinstance(value, pd.DataFrame):
        default_index(value)
        names = list(value.columns)
        if value.columns.name is not None or not all(type(name) is str for name in names):
            fail("COLUMN_METADATA")
        if len(names) != len(set(names)):
            fail("DUPLICATE_COLUMNS")
        if any("\0" in name for name in names):
            fail("NUL_STRING")
        return {"kind": "table", "shape": value.shape, "names": names,
                "columns": [describe(value.iloc[:, i]) for i in range(len(names))]}
    if isinstance(value, pd.Series):
        default_index(value)
        if value.name is not None and type(value.name) is not str:
            fail("SERIES_LABEL")
        if isinstance(value.name, str) and "\0" in value.name:
            fail("NUL_STRING")
        name = str(value.dtype)
        if name in EXTENSIONS:
            if isinstance(value.dtype, pd.StringDtype) and value.dtype.storage != "python":
                fail("STRING_STORAGE")
            dtype, nullable = EXTENSIONS[name], True
        else:
            if not isinstance(value.dtype, np.dtype):
                fail("UNSUPPORTED_DTYPE")
            dtype, nullable = np.dtype(value.dtype), False
        kind, shape, label = "series", (len(value),), value.name
    elif np.ma.isMaskedArray(value):
        dtype, kind, shape, nullable, label = value.dtype, "masked", value.shape, True, None
    elif isinstance(value, np.ndarray):
        dtype, kind, shape, nullable, label = value.dtype, "array", value.shape, False, None
    elif isinstance(value, np.generic):
        dtype, kind, shape, nullable, label = value.dtype, "numpy_scalar", (), False, None
    elif type(value) in (bool, int, float, str):
        dtype, kind, shape, nullable, label = np.asarray(value).dtype, "scalar", (), False, None
    else:
        fail("UNSUPPORTED_TYPE")
    if dtype.kind not in FAMILIES:
        fail("UNSUPPORTED_DTYPE")
    if dtype.kind == "f" and dtype.itemsize not in (4, 8):
        fail("FLOAT_WIDTH")
    if not dtype.isnative:
        fail("BYTE_ORDER")
    if any(size > 2147483647 for size in shape):
        fail("R_DIMENSION_RANGE")
    return {"kind": kind, "dtype": dtype, "pandas_dtype": value.dtype if kind == "series" else None,
            "family": FAMILIES[dtype.kind], "shape": shape, "nullable": nullable,
            "label": label, "r_dim": shape if kind in ("array", "masked") and shape else None}


def flat_source(value, meta):
    if meta["kind"] == "series":
        if meta["nullable"]:
            dtype = object if meta["family"] == "character" else meta["dtype"]
            fill = "" if meta["family"] == "character" else 0
            values = value.to_numpy(dtype=dtype, na_value=fill)
            missing = value.isna().to_numpy(dtype=bool)
        else:
            values = value.to_numpy(dtype=meta["dtype"])
            missing = np.zeros(len(values), dtype=bool)
    elif meta["kind"] == "masked":
        values = value.data.ravel(order="F")
        missing = np.ma.getmaskarray(value).ravel(order="F")
    else:
        values = np.asarray(value).ravel(order="F")
        missing = np.zeros(len(values), dtype=bool)
    return values, missing


def canonical_nan_guard(array, present):
    width = array.dtype.itemsize
    bits = array.view(f"u{width}")
    exponent = 0x7F800000 if width == 4 else 0x7FF0000000000000
    mantissa = 0x007FFFFF if width == 4 else 0x000FFFFFFFFFFFFF
    canonical = 0x00400000 if width == 4 else 0x0008000000000000
    for first in range(0, len(array), BLOCK):
        block = bits[first:first + BLOCK]
        invalid = ((block & exponent) == exponent) & ((block & mantissa) != 0) & ((block & mantissa) != canonical)
        if present is not None:
            invalid &= present[first:first + BLOCK]
        if invalid.any():
            fail("NAN_REPRESENTATION")


def encode_vector(value, meta):
    values, missing = flat_source(value, meta)
    family = meta["family"]
    if family == "double":
        canonical_nan_guard(values, ~missing if meta["nullable"] else None)
    if family == "integer":
        for first in range(0, len(values), BLOCK):
            part = values[first:first + BLOCK][~missing[first:first + BLOCK]]
            if np.any(part < -2147483647) or np.any(part > 2147483647):
                fail("R_INTEGER_RANGE")
    if family == "character":
        target = ro.r["character"](len(values))
        for first in range(0, len(values), BLOCK):
            part = []
            for item, absent in zip(values[first:first + BLOCK], missing[first:first + BLOCK]):
                text = "" if absent else str(item)
                if "\0" in text:
                    fail("NUL_STRING")
                try:
                    text.encode("utf8")
                except UnicodeEncodeError:
                    fail("INVALID_UNICODE")
                part.append(text)
            target[first:first + len(part)] = ro.StrVector(part)
        if missing.any():
            flags = ro.r["logical"](len(values))
            np.asarray(flags)[:] = missing
            target = ro.r("function(x, absent) { x[absent] <- NA_character_; x }")(target, flags)
    else:
        target = ro.r[family](len(values))
        buffer = np.asarray(target)
        if not buffer.flags.writeable or buffer.dtype != np.dtype("float64" if family == "double" else "int32"):
            fail("R_STORAGE_LAYOUT")
        for first in range(0, len(values), BLOCK):
            last = min(first + BLOCK, len(values))
            with np.errstate(invalid="ignore", over="ignore"):
                buffer[first:last] = values[first:last]
        buffer[missing] = np.asarray(ro.FloatVector([ro.NA_Real]))[0] if family == "double" else -2147483648
    if meta["r_dim"] is not None:
        target.do_slot_assign("dim", ro.IntVector(meta["r_dim"]))
    actual_na, actual_nan = r_masks(target)
    if not np.array_equal(actual_na, missing):
        fail("ENCODE_MISSINGNESS")
    if family == "double":
        observed = np.asarray(target).reshape(-1, order="F")
        for first in range(0, len(values), BLOCK):
            last = min(first + BLOCK, len(values))
            present = ~missing[first:last]
            if not np.array_equal(actual_nan[first:last], np.isnan(values[first:last]) & present):
                fail("ENCODE_NAN")
            expected = values[first:last][present].astype(np.float64)
            restored = observed[first:last][present]
            if not np.array_equal(expected.view(np.uint64), restored.view(np.uint64)):
                fail("ENCODE_PRECISION")
    return target


def encode(value, meta):
    if meta["kind"] != "table":
        return encode_vector(value, meta)
    columns = [(name, encode_vector(value.iloc[:, i], meta["columns"][i]))
               for i, name in enumerate(meta["names"])]
    return ro.r("""function(x,n) structure(x, class='data.frame',
        row.names=if(n == 0L) integer(0) else c(NA_integer_, -n))""")(
        ro.ListVector(dict(columns)), ro.IntVector([meta["shape"][0]]))


def decode_vector(value, meta):
    if str(ro.r["typeof"](value)[0]) != meta["family"]:
        fail("R_TYPE_FAMILY")
    if r_dims(value) != meta["r_dim"] or len(value) != math.prod(meta["shape"]):
        fail("R_SHAPE")
    check_attrs(value, {"dim"} if meta["r_dim"] is not None else set())
    missing, nan = r_masks(value)
    if not meta["nullable"] and missing.any():
        fail("NONNULLABLE_NA")
    family = meta["family"]
    if family == "character":
        raw = np.empty(len(value), dtype=object if meta["kind"] == "series" else meta["dtype"])
        for first in range(0, len(value), BLOCK):
            last = min(first + BLOCK, len(value))
            part = ["" if absent else str(item) for item, absent in zip(value[first:last], missing[first:last])]
            if meta["kind"] != "series" and any(len(text) > meta["dtype"].itemsize // 4 for text in part):
                fail("STRING_WIDTH")
            raw[first:last] = part
    else:
        source = np.asarray(value).reshape(-1, order="F")
    if family == "integer":
        limits = np.iinfo(meta["dtype"])
        for first in range(0, len(source), BLOCK):
            part = source[first:first + BLOCK][~missing[first:first + BLOCK]]
            if np.any(part < limits.min) or np.any(part > limits.max):
                fail("INTEGER_WIDTH")
    elif family == "double":
        canonical_nan_guard(source, ~missing if meta["nullable"] else None)
        if meta["dtype"].itemsize == 4:
            for first in range(0, len(source), BLOCK):
                present = ~missing[first:first + BLOCK]
                original = source[first:first + BLOCK][present]
                with np.errstate(over="ignore", invalid="ignore"):
                    restored = original.astype(np.float32).astype(np.float64)
                if not np.array_equal(original.view(np.uint64), restored.view(np.uint64)):
                    fail("FLOAT_PRECISION")
    if family != "character":
        with np.errstate(over="ignore", invalid="ignore"):
            raw = source.astype(meta["dtype"], copy=True)
        raw[missing] = 0
    if meta["kind"] == "series":
        if meta["nullable"] and family == "double":
            array = pd.arrays.FloatingArray(raw, missing)
        elif meta["nullable"] and family == "integer":
            array = pd.arrays.IntegerArray(raw, missing)
        elif meta["nullable"] and family == "logical":
            array = pd.arrays.BooleanArray(raw, missing)
        elif meta["nullable"]:
            raw[missing] = pd.NA
            array = pd.array(raw, dtype=meta["pandas_dtype"])
        else:
            array = raw
        return pd.Series(array, name=meta["label"], dtype=meta["pandas_dtype"])
    array = np.asarray(raw, dtype=meta["dtype"]).reshape(meta["shape"], order="F")
    if meta["kind"] == "masked":
        return np.ma.array(array, mask=missing.reshape(meta["shape"], order="F"))
    if meta["kind"] == "numpy_scalar":
        return array[()]
    if meta["kind"] == "scalar":
        return array.item()
    return array


def decode(value, meta):
    if meta["kind"] != "table":
        return decode_vector(value, meta)
    if list(value.rclass) != ["data.frame"]:
        fail("R_TABLE_CLASS")
    check_attrs(value, {"names", "row.names", "class"})
    names = [] if isinstance(value.names, type(ro.NULL)) else list(value.names)
    if r_dims(value) != meta["shape"] or names != meta["names"]:
        fail("R_TABLE_STRUCTURE")
    rows = meta["shape"][0]
    if int(ro.r[".row_names_info"](value, 1)[0]) != -rows:
        for first in range(0, rows, BLOCK):
            if not bool(ROW_NAMES_BLOCK(value, first + 1, min(first + BLOCK, rows))[0]):
                fail("R_ROW_NAMES")
    result = pd.DataFrame(index=pd.RangeIndex(rows))
    for i, name in enumerate(meta["names"]):
        result[name] = decode_vector(value[i], meta["columns"][i])
    return result


def native_meta(value):
    if list(value.rclass) == ["data.frame"]:
        check_attrs(value, {"names", "row.names", "class"})
        names = list(value.names)
        if any(type(name) is not str or "\0" in name for name in names) or len(names) != len(set(names)):
            fail("COLUMN_METADATA")
        columns = [native_meta(value[i]) for i in range(len(names))]
        if any(column["kind"] != "series" for column in columns):
            fail("NESTED_COLUMN")
        return {"kind": "table", "shape": r_dims(value), "names": names, "columns": columns}
    family, dimensions = str(ro.r["typeof"](value)[0]), r_dims(value)
    if family not in ("integer", "logical", "double", "character"):
        fail("R_TYPE_FAMILY")
    check_attrs(value, {"dim"} if dimensions is not None else set())
    if dimensions is None:
        names = {"integer": "Int32", "logical": "boolean", "double": "Float64", "character": "string"}
        return {"kind": "series", "dtype": EXTENSIONS[names[family]],
                "pandas_dtype": pd.api.types.pandas_dtype(names[family]), "family": family,
                "shape": (len(value),), "nullable": True, "label": None, "r_dim": None}
    mapping = {"integer": np.dtype("int32"), "logical": np.dtype("bool"), "double": np.dtype("float64")}
    if family not in mapping:
        fail("NATIVE_CHARACTER_ARRAY")
    return {"kind": "masked", "dtype": mapping[family], "pandas_dtype": None, "family": family,
            "shape": dimensions, "nullable": True, "label": None, "r_dim": dimensions}


def family(meta):
    if meta["kind"] in ("scalar", "numpy_scalar"):
        return "scalar"
    if meta["kind"] in ("series", "table"):
        return "table"
    return "array"


def publish(name, value, hint=None):
    meta = describe(value)
    if hint is not None and family(meta) != hint:
        fail("TYPE_FAMILY")
    target = encode(value, meta)
    ro.globalenv[name] = target
    schemas[name] = meta
    return target


def read(name, hint=None):
    if name not in ro.globalenv:
        fail("VARIABLE_NOT_FOUND")
    value = ro.globalenv[name]
    meta = schemas[name] if name in schemas else native_meta(value)
    if hint is not None and family(meta) != hint:
        fail("TYPE_FAMILY")
    return decode(value, meta), meta


def retrieve(name):
    value, meta = read(name)
    schemas[name] = meta
    return value


def pull(name, namespace, hint=None):
    value, meta = read(name, hint)
    namespace[name] = value
    schemas[name] = meta


def run_cell(code, language, sharing):
    shell = get_ipython()
    namespace = shell.user_ns

    def transfer(entry):
        name, hint = entry["name"], entry.get("family")
        if entry["direction"] == "python-to-r":
            if name not in namespace:
                fail("VARIABLE_NOT_FOUND")
            publish(name, namespace[name], hint)
        else:
            pull(name, namespace, hint)

    incoming = "r-to-python" if language == "python" else "python-to-r"
    for entry in sharing:
        if entry["direction"] == incoming:
            transfer(entry)
    if language == "r":
        shell.run_cell_magic("R", "", code)
    else:
        result = shell.run_cell(code, store_history=False)
        if result.error_before_exec or result.error_in_exec:
            return
    for entry in sharing:
        if entry["direction"] != incoming:
            transfer(entry)
