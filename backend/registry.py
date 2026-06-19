#!/usr/bin/env python3
"""
Fund / supervising-authority registry.

Loads the official numbering tables (fund_registry.json) and resolves a free-text
fund name from form data to its canonical entry — standard name, fund code, and
supervising authority (主管機關) — so responses can be consolidated by
主管機關 → 機關/基金.

Matching order (ported from cormort/excel_merge):
  1. exact match on a normalized alias or canonical name
  2. fuzzy match: same first 4 characters AND identical length
"""

import re
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

REGISTRY_PATH = Path(__file__).parent / "fund_registry.json"

_registry = {"version": "", "domains": {}}
_alias_index = {}    # normalized name/alias -> entry
_prefix_index = {}   # (first4, length) -> entry  (fuzzy fallback)


def _norm(s):
    """Normalize for matching: drop all whitespace, keep characters as-is."""
    return re.sub(r"\s+", "", str(s if s is not None else "")).strip()


def load_registry():
    """(Re)load the registry from disk and rebuild lookup indexes."""
    global _registry, _alias_index, _prefix_index
    _alias_index = {}
    _prefix_index = {}
    if not REGISTRY_PATH.exists():
        logger.warning("fund_registry.json not found at %s", REGISTRY_PATH)
        _registry = {"version": "", "domains": {}}
        return _registry
    try:
        _registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.error("Failed to parse fund_registry.json: %s", e)
        _registry = {"version": "", "domains": {}}
        return _registry

    for dom, dd in _registry.get("domains", {}).items():
        sups = dd.get("supervisors", {})
        for f in dd.get("funds", []):
            entry = {
                "domain": dom,
                "code": f.get("code", ""),
                "name": f.get("name", ""),
                "supervisor": f.get("supervisor", ""),
                "supervisor_name": sups.get(f.get("supervisor", ""), ""),
                "category": f.get("category", ""),
            }
            # exact index: canonical name + all aliases (first writer wins)
            for key in [f.get("name", "")] + list(f.get("aliases", []) or []):
                nk = _norm(key)
                if nk:
                    _alias_index.setdefault(nk, entry)
            # fuzzy index on canonical name
            nm = _norm(f.get("name", ""))
            if len(nm) >= 4:
                _prefix_index.setdefault((nm[:4], len(nm)), entry)

    logger.info("Loaded fund registry: %d names indexed across %d domain(s)",
                len(_alias_index), len(_registry.get("domains", {})))
    return _registry


def match_fund(name):
    """Resolve a fund name to its canonical entry, or None if no match.

    Returns a dict: {domain, code, name, supervisor, supervisor_name, category}.
    """
    nk = _norm(name)
    if not nk:
        return None
    hit = _alias_index.get(nk)
    if hit:
        return hit
    if len(nk) >= 4:
        return _prefix_index.get((nk[:4], len(nk)))
    return None


def get_registry():
    """Return the raw registry dict (for the /api/registry endpoint)."""
    return _registry


def list_supervisors():
    """Flat list of all supervising authorities across domains."""
    out = []
    for dom, dd in _registry.get("domains", {}).items():
        label = dd.get("label", dom)
        for code, nm in dd.get("supervisors", {}).items():
            out.append({"domain": dom, "domain_label": label, "code": code, "name": nm})
    return out


# Load once at import.
load_registry()
