import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from backend import registry


def test_registry_loaded():
    reg = registry.get_registry()
    assert "enterprise" in reg["domains"]
    assert "special" in reg["domains"]


def test_supervisors_span_both_domains():
    sups = registry.list_supervisors()
    domains = {s["domain"] for s in sups}
    assert domains == {"enterprise", "special"}
    # every supervisor entry carries a code and a name
    assert all(s["code"] and s["name"] for s in sups)


def test_match_alias():
    m = registry.match_fund("台糖")
    assert m is not None
    assert m["code"] == "2106"
    assert m["supervisor_name"] == "經濟部主管"
    assert m["domain"] == "enterprise"


def test_match_canonical_name():
    m = registry.match_fund("中央銀行")
    assert m is not None
    assert m["code"] == "0105"


def test_match_whitespace_tolerant():
    m = registry.match_fund("  中央銀行  ")
    assert m is not None and m["code"] == "0105"


def test_special_fund_code_has_category_prefix():
    # 國立臺灣大學校務基金: 作業基金(1) + 教育部(12) + 101 -> 112101
    m = registry.match_fund("國立臺灣大學校務基金")
    assert m is not None
    assert m["code"] == "112101"
    assert m["domain"] == "special"


def test_no_match_returns_none():
    assert registry.match_fund("這個基金不存在XYZ") is None
    assert registry.match_fund("") is None
    assert registry.match_fund(None) is None
