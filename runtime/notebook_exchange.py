# Inspectable AIRA mixed-language Notebook bootstrap v1.
# Dependencies: IPython/ipykernel, R, rpy2 3.5.17, NumPy 2.2, pandas 2.2.
# @id CODE-XCH-BOOTSTRAP @implements REQ-XCH-002
import json as _aira_json
import types as _aira_types

_aira_bridge = _aira_types.ModuleType("aira_notebook_bridge")
exec(__AIRA_BRIDGE_SOURCE__, _aira_bridge.__dict__)
_aira_bridge.get_ipython = get_ipython
get_ipython().run_line_magic("load_ext", "rpy2.ipython")


def _aira_execute(language, source, sharing_json):
    _aira_bridge.run_cell(source, language, _aira_json.loads(sharing_json))
