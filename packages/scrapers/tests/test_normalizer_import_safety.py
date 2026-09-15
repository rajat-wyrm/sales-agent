import ast
import os
import re


def test_module_annotations_resolve_under_the_running_interpreter():
    """`from __future__ import annotations` is not used here, so every annotation in
    a module-level signature is evaluated at import time. Local Python 3.14 tolerated
    an un-imported Optional[...] that crashed the 3.12 worker container on boot --
    importing the module is the only check that catches it, and pytest's own
    interpreter may differ from the deployed one, so assert against both spellings."""
    import subprocess, sys, os
    src = open(os.path.join(os.path.dirname(__file__), "..", "scrapers", "normalizer.py")).read()
    # No forward references left undefined: compile + exec the header imports.
    tree = ast.parse(src)
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported |= {a.asname or a.name for a in node.names}
        elif isinstance(node, ast.Import):
            imported |= {(a.asname or a.name).split(".")[0] for a in node.names}
    builtin_typing = {"Any", "Optional", "Union", "Literal", "TypedDict", "Sequence",
                      "Mapping", "Iterable", "Callable", "Dict", "List", "Tuple"}
    used = {n.id for n in ast.walk(tree)
            if isinstance(n, ast.Name) and n.id in builtin_typing}
    missing = used - imported
    assert not missing, f"typing names used but never imported: {sorted(missing)}"
    # And the module must actually import in a clean interpreter.
    r = subprocess.run([sys.executable, "-c", "import scrapers.normalizer"],
                       cwd=os.path.join(os.path.dirname(__file__), ".."),
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-500:]


def test_dedup_update_placeholders_match_argument_order():
    """asyncpg binds positionally: the SQL can read perfectly while the Python
    argument list is one slot off. Appending PARSER_VERSION before `existing` put
    '4' into the $18 uuid parameter and only failed at execution time -- grep of the
    SQL text could not see it. Compare max placeholder against the real arg count."""
    src = open(os.path.join(os.path.dirname(__file__), "..", "scrapers", "normalizer.py")).read()
    tree = ast.parse(src)
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, ast.AsyncFunctionDef) and n.name == "insert_lead")
    calls = [n for n in ast.walk(fn)
             if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "execute"
             and isinstance(n.args[0], ast.Constant)
             and "UPDATE job_postings SET" in str(n.args[0].value)]
    assert len(calls) == 2, f"expected both dedup UPDATEs, found {len(calls)}"
    for call in calls:
        sql = call.args[0].value
        highest = max(int(m) for m in re.findall(r"\$(\d+)", sql))
        # Every positional arg after the SQL literal (a Tuple/Starred counts as many;
        # here they are all flat expressions).
        args = call.args[1:]
        assert len(args) == highest, f"{len(args)} args but SQL uses ${highest}"
        # parser_version is the last placeholder, so PARSER_VERSION must be last arg.
        assert any(isinstance(a, ast.Name) and a.id == "PARSER_VERSION" for a in args[-1:]), \
            "PARSER_VERSION must bind to the final placeholder"
