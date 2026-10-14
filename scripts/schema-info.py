#!/usr/bin/env python3
"""Print a database's schema as sorted, normalized DEFINE statements.

Reads only INFO FOR DB / INFO FOR TABLE (no records), so it is safe against
a populated database. Normalization: OVERWRITE and IF NOT EXISTS dropped,
the JWT/issuer key clause of DEFINE ACCESS removed, database users skipped
(credentials, not schema).

  SURREAL_AUTH=user:pass scripts/schema-info.py [--apply] <http-url> <ns> <db>

Default output is sorted and normalized for comparison (scripts/schema-diff.sh).
--apply prints the same definitions in an order that applies to an empty
database: tables, then each table's fields (parents before `.*` elements, as
DEFINE FIELD OVERWRITE because an array field implicitly creates its element
field), indexes and events, then database-level definitions. This is how
database/migrations/000_baseline.surql was generated from production.
"""
import base64
import json
import os
import re
import sys
import urllib.request

KEY_CLAUSE = re.compile(
    r" WITH JWT ALGORITHM \w+ KEY '(?:[^'\\]|\\.)*'(?: WITH ISSUER KEY '(?:[^'\\]|\\.)*')?"
)
DB_SECTIONS = ("accesses", "analyzers", "apis", "buckets", "configs", "functions",
               "models", "params", "sequences", "tables")
TABLE_SECTIONS = ("events", "fields", "indexes", "lives", "tables")


def query(url: str, auth: str, ns: str, db: str, sql: str):
    req = urllib.request.Request(
        f"{url.rstrip('/')}/sql",
        data=sql.encode(),
        headers={
            "Accept": "application/json",
            "surreal-ns": ns,
            "surreal-db": db,
            "Authorization": "Basic " + base64.b64encode(auth.encode()).decode(),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        out = json.load(resp)
    for stmt in out:
        if stmt.get("status") != "OK":
            sys.exit(f"schema-info: query failed: {str(stmt.get('result'))[:200]}")
    return [stmt["result"] for stmt in out]


def normalize(definition: str) -> str:
    d = re.sub(r"^DEFINE (\w+) (?:OVERWRITE|IF NOT EXISTS) ", r"DEFINE \1 ", definition.strip())
    d = KEY_CLAUSE.sub("", d)
    if " KEY '" in d:
        sys.exit("schema-info: a definition still carries a KEY; refusing to print it")
    return d.rstrip(";") + ";"


def collect(url: str, auth: str, ns: str, db: str):
    [info] = query(url, auth, ns, db, "INFO FOR DB;")
    tables = sorted((info.get("tables") or {}).keys())
    per_table = {}
    if tables:
        results = query(url, auth, ns, db, "".join(f"INFO FOR TABLE `{t}`;" for t in tables))
        per_table = dict(zip(tables, results))
    return info, tables, per_table


def schema(url: str, auth: str, ns: str, db: str) -> list[str]:
    info, _, per_table = collect(url, auth, ns, db)
    lines: list[str] = []
    for section in DB_SECTIONS:
        lines += [normalize(v) for v in (info.get(section) or {}).values()]
    for tinfo in per_table.values():
        for section in TABLE_SECTIONS:
            if section == "tables":
                continue  # foreign-table views are listed on the DB already
            lines += [normalize(v) for v in (tinfo.get(section) or {}).values()]
    return sorted(set(lines))


def apply_order(url: str, auth: str, ns: str, db: str) -> list[str]:
    info, tables, per_table = collect(url, auth, ns, db)
    lines: list[str] = []
    for t in tables:
        lines.append(normalize(info["tables"][t]))
        tinfo = per_table[t]
        for _, d in sorted((tinfo.get("fields") or {}).items()):
            lines.append(normalize(d).replace("DEFINE FIELD ", "DEFINE FIELD OVERWRITE ", 1))
        for section in ("indexes", "events"):
            lines += [normalize(d) for _, d in sorted((tinfo.get(section) or {}).items())]
    for section in DB_SECTIONS:
        if section == "tables":
            continue
        lines += [normalize(d) for _, d in sorted((info.get(section) or {}).items())]
    return lines


if __name__ == "__main__":
    args = sys.argv[1:]
    mode = schema
    if args[:1] == ["--apply"]:
        mode, args = apply_order, args[1:]
    if len(args) != 3 or "SURREAL_AUTH" not in os.environ:
        sys.exit(__doc__)
    for line in mode(args[0], os.environ["SURREAL_AUTH"], args[1], args[2]):
        print(line)
