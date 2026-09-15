import inspect
import re




import inspect
import re


def test_prompt_template_placeholders_all_supplied():
    """DRAFT_PROMPT_TEMPLATE.format(**{...}) raises KeyError on ANY placeholder the
    caller does not pass -- and that crash already disabled AI drafting entirely once,
    silently falling back to the canned template for every lead. Adding a field to the
    prompt without adding it to the format() dict reproduces it, so compare the two
    sets instead of trusting a happy-path render."""
    import string as _string
    from scrapers.draft_worker import DRAFT_PROMPT_TEMPLATE, generate_gemini_drafts
    needed = {f for _, f, _, _ in _string.Formatter().parse(DRAFT_PROMPT_TEMPLATE) if f}
    src = inspect.getsource(generate_gemini_drafts)
    i = src.index("DRAFT_PROMPT_TEMPLATE.format")
    supplied = set(re.findall(r'"([a-z_]+)":', src[i:i + 1400]))
    missing = needed - supplied
    assert not missing, (
        f"prompt placeholders never passed to .format(): {sorted(missing)} -- "
        "this raises KeyError at runtime and silently kills AI drafting"
    )
