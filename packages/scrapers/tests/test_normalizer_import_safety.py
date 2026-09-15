import ast


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
