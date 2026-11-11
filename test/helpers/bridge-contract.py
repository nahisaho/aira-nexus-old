import numpy as np
import pandas as pd
import typed_bridge as bridge


def same(expected, actual):
    if isinstance(expected, pd.DataFrame):
        pd.testing.assert_frame_equal(expected, actual, check_exact=True)
        for name in expected.columns:
            same(expected[name], actual[name])
    elif isinstance(expected, pd.Series):
        pd.testing.assert_series_equal(expected, actual, check_exact=True)
        if pd.api.types.is_float_dtype(expected.dtype):
            mask = expected.isna().to_numpy()
            dtype = expected.dtype.numpy_dtype if hasattr(expected.dtype, "numpy_dtype") else expected.dtype
            a = expected.to_numpy(dtype=dtype, na_value=0)[~mask]
            b = actual.to_numpy(dtype=dtype, na_value=0)[~mask]
            np.testing.assert_array_equal(a.view(f"u{a.dtype.itemsize}"), b.view(f"u{b.dtype.itemsize}"))
    else:
        assert type(expected) is type(actual)
        a, b = np.asarray(expected), np.asarray(actual)
        assert a.dtype == b.dtype and a.shape == b.shape
        mask = np.ma.getmaskarray(expected) if np.ma.isMaskedArray(expected) else np.zeros(a.shape, bool)
        if np.ma.isMaskedArray(expected):
            np.testing.assert_array_equal(mask, np.ma.getmaskarray(actual))
        if a.dtype.kind == "f":
            np.testing.assert_array_equal(a[~mask].view(f"u{a.dtype.itemsize}"), b[~mask].view(f"u{b.dtype.itemsize}"))
        else:
            np.testing.assert_array_equal(a[~mask], b[~mask])


def run_contract():
    cases = 0
    values = [True, 2147483647, -0.0, "研究",
              np.array(3.25), np.array(["", "研究", "μm"]),
              np.arange(24, dtype=np.int16).reshape(2, 3, 4),
              np.asfortranarray(np.arange(24.0).reshape(2, 3, 4)),
              np.arange(20, dtype=np.int32).reshape(4, 5)[:, ::2],
              np.empty((0, 3)), pd.DataFrame(index=pd.RangeIndex(3)),
              np.ma.array([1, 0, -2147483647], mask=[0, 1, 0], dtype=np.int64),
              np.ma.array([np.nan, 0, -0.0, 0.5], mask=[0, 1, 0, 0])]
    for dtype in ("int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64"):
        values.append(np.array([0, 1, 7], dtype=dtype))
    for dtype in ("float32", "float64"):
        floating = np.dtype(dtype).type
        values.append(np.array([0, -0.0, np.inf, -np.inf, np.nan, -np.nan,
                                np.nextafter(floating(0), floating(1))], dtype=dtype))
    for dtype in ("Int8", "Int16", "Int32", "Int64", "UInt8", "UInt16", "UInt32", "UInt64",
                  "Float32", "Float64", "boolean", "string"):
        nonmissing = "x" if dtype == "string" else True if dtype == "boolean" else 1
        values.append(pd.Series(pd.array([nonmissing, None], dtype=dtype), name="value (m)"))
    values.append(pd.DataFrame({"n": pd.array([1, None], dtype="Int64"),
                                "s": pd.array(["α", None], dtype="string"),
                                "f": pd.arrays.FloatingArray(np.array([np.nan, -0.0]), np.array([False, True]))}))
    for value in values:
        bridge.publish("contract", value)
        same(value, bridge.retrieve("contract"))
        cases += 1
    invalid = [np.array([-2147483648], dtype=np.int32), np.array([2**53 + 1], dtype=np.int64),
               np.array([2**64 - 1], dtype=np.uint64), np.array(["x", None], dtype=object),
               np.array([1 + 2j]), np.array([0.1], dtype=np.float16),
               np.array([0x7FF8000000000042], dtype="uint64").view("float64"),
               np.array([0x7F800042], dtype="uint32").view("float32"),
               np.array([0.5], dtype=">f8"), np.array(["a\0b"]),
               pd.Series([1], name=7), pd.Series(pd.Categorical(["x"])),
               pd.Series(pd.date_range("2020-01-01", periods=1, tz="UTC")),
               pd.DataFrame({"x": [1]}, index=["custom"]),
               pd.DataFrame([[1, 2]], columns=["x", "x"])]
    for value in invalid:
        bridge.publish("contract", 17)
        previous = bridge.schemas["contract"]
        try:
            bridge.publish("contract", value)
        except bridge.SharedValueError:
            assert bridge.retrieve("contract") == 17
            assert bridge.schemas["contract"] is previous
        else:
            raise AssertionError("unsupported conversion silently accepted")
        cases += 1
    bridge.publish("drift", np.array([0.5], dtype=np.float32))
    bridge.ro.r("drift[1] <- 1/10")
    try:
        bridge.retrieve("drift")
    except bridge.SharedValueError as error:
        assert error.code == "FLOAT_PRECISION"
    else:
        raise AssertionError("precision-losing Float32 narrowing accepted")
    destination = {"shape_guard": np.array([1, 2, 3], dtype=np.int32)}
    original = destination["shape_guard"]
    bridge.publish("shape_guard", original)
    schema = bridge.schemas["shape_guard"]
    bridge.ro.r("dim(shape_guard) <- c(1L,3L)")
    try:
        bridge.pull("shape_guard", destination, "array")
    except bridge.SharedValueError as error:
        assert error.code == "R_SHAPE"
        assert destination["shape_guard"] is original and bridge.schemas["shape_guard"] is schema
    else:
        raise AssertionError("changed R shape silently replaced destination")
    destination = {"table_guard": pd.DataFrame({"a": [1], "b": [2]})}
    original = destination["table_guard"]
    bridge.publish("table_guard", original)
    schema = bridge.schemas["table_guard"]
    bridge.ro.r("names(table_guard) <- c('changed','b')")
    try:
        bridge.pull("table_guard", destination, "table")
    except bridge.SharedValueError as error:
        assert error.code == "R_TABLE_STRUCTURE"
        assert destination["table_guard"] is original and bridge.schemas["table_guard"] is schema
    else:
        raise AssertionError("changed R columns silently replaced destination")
    bridge.ro.r("fresh_real <- c(NA_real_, NaN, -0.0, Inf); fresh_int <- c(1L, NA_integer_); fresh_bool <- c(TRUE, NA); fresh_text <- c('研究', NA_character_)")
    real = bridge.retrieve("fresh_real")
    assert str(real.dtype) == "Float64" and real.name is None
    assert real.array._mask.tolist() == [True, False, False, False]
    assert np.isnan(real.array._data[1])
    assert np.signbit(real.array._data[2])
    for name, dtype in (("fresh_int", "Int32"), ("fresh_bool", "boolean"), ("fresh_text", "string")):
        value = bridge.retrieve(name)
        assert str(value.dtype) == dtype and value.isna().tolist() == [False, True]
    bridge.ro.r("fresh_matrix <- array(c(1L, NA_integer_, 3L, 4L), dim=c(2L,2L)); fresh_frame <- data.frame(a=c(1L,NA_integer_), b=c('μm',NA_character_), check.names=FALSE)")
    matrix = bridge.retrieve("fresh_matrix")
    assert np.ma.isMaskedArray(matrix) and matrix.dtype == np.dtype("int32")
    assert matrix.shape == (2, 2)
    np.testing.assert_array_equal(matrix.mask, [[False, False], [True, False]])
    table = bridge.retrieve("fresh_frame")
    assert list(table.columns) == ["a", "b"] and str(table.a.dtype) == "Int32"
    assert str(table.b.dtype) == "string" and table.b.isna().tolist() == [False, True]
    for expression in ("bad <- array(c('x','y'),dim=c(1L,2L))",
                       "bad <- structure(1:2, names=c('x','y'))",
                       "bad <- factor(c('a','b'))",
                       "bad <- data.frame(a=1L,b=2L); names(bad) <- c('x','x')"):
        bridge.ro.r(expression)
        try:
            bridge.retrieve("bad")
        except bridge.SharedValueError:
            assert "bad" not in bridge.schemas
        else:
            raise AssertionError("unmodeled R metadata accepted")
    destination = {"held": 37}
    bridge.ro.r("held <- 1:3")
    try:
        bridge.pull("held", destination, "scalar")
    except bridge.SharedValueError:
        assert destination["held"] == 37 and "held" not in bridge.schemas
    else:
        raise AssertionError("R vector silently coerced to scalar family")
    return cases + 12
