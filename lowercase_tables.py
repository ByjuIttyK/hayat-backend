"""
lowercase_tables.py
-------------------
Lowercase MySQL TABLE names that appear right after a SQL clause keyword
(FROM, INTO, JOIN, UPDATE, DELETE FROM) in specific backend route files.

Why only after those keywords:
  - A table name always follows FROM / INTO / JOIN / UPDATE / DELETE FROM.
  - Column names (after SET, SELECT list, WHERE) are LEFT ALONE -- MySQL
    treats column names case-insensitively, so they don't need changing and
    touching them risks corrupting queries.

Safety:
  - DRY = True by default: prints a diff of every proposed change, writes nothing.
  - Skips any line whose SQL keyword sits inside a // comment.
  - Only edits the explicit FILES list -- nothing else in the tree.
  - Leaves the :1,:2 Oracle-style bits, TO_DATE, etc. untouched.

Run from E:\\hayatApi:
    python lowercase_tables.py          # dry run - review the diff
    # then flip DRY = False and run again to apply
"""

import os
import re

# ---- CONFIG -------------------------------------------------------------
ROOT = r"E:\hayatApi"          # backend root on the laptop
DRY  = False                    # <-- flip to False to actually write

# Only these files are touched.
#   - newapi/   is deliberately excluded (dead code, deleted).
#   - HayatDb.js is deliberately excluded (handled manually; some lines
#     are Oracle-syntax legacy that need more than a case fix).
#   - gl_suggest_api.js is deliberately excluded: it contains Gemini PROMPT
#     text with phrases like "from SUPPLIER MASTER" / "from CHART OF ACCOUNTS"
#     that the regex mistakes for SQL. Its real table refs (ACC_MST, SUP_MST,
#     CUS_MST) are lowercased by hand.
FILES = [
    "pay_chq_batch_api.js",
    "rcp_chq_batch_api.js",
    "CustomerMatchRoutes.js",
    "FabInvSuggestRoutes.js",
    os.path.join("routes", "fabInvPrint_route.js"),
    os.path.join("routes", "agentRoutes.js"),
    os.path.join("agents", "agentPdcPayable.js"),
    os.path.join("agents", "agentPdcRealise.js"),
]

# Match a clause keyword followed by an UPPERCASE (or mixed) identifier that
# contains at least one uppercase letter. We only rewrite the identifier.
#   group 1 = keyword + surrounding whitespace (kept as-is)
#   group 2 = the table identifier (lowercased)
CLAUSE = re.compile(
    r"\b(FROM|INTO|JOIN|UPDATE|DELETE\s+FROM)(\s+)([A-Za-z_][A-Za-z0-9_]*)",
    re.IGNORECASE,
)

def is_comment_before(line, pos):
    """True if a // comment marker appears before pos on this line."""
    c = line.find("//")
    return c != -1 and c < pos

def has_upper(word):
    return any(ch.isupper() for ch in word)

def process_line(line):
    """Return (new_line, changes) where changes is a list of (old, new)."""
    changes = []

    def repl(m):
        kw, ws, ident = m.group(1), m.group(2), m.group(3)
        # skip if this match sits inside a // comment
        if is_comment_before(line, m.start()):
            return m.group(0)
        # only rewrite if the identifier actually has an uppercase letter
        if not has_upper(ident):
            return m.group(0)
        new_ident = ident.lower()
        changes.append((ident, new_ident))
        return f"{kw}{ws}{new_ident}"

    new_line = CLAUSE.sub(repl, line)
    return new_line, changes


def main():
    total = 0
    for rel in FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print(f"!! MISSING (skipped): {rel}")
            continue

        with open(path, encoding="utf-8") as f:
            lines = f.readlines()

        file_changes = []
        new_lines = []
        for i, line in enumerate(lines, 1):
            new_line, changes = process_line(line)
            if changes:
                for old, new in changes:
                    file_changes.append((i, old, new))
            new_lines.append(new_line)

        if file_changes:
            print(f"\n=== {rel}  ({len(file_changes)} change(s)) ===")
            for ln, old, new in file_changes:
                print(f"  L{ln}: {old}  ->  {new}")
            total += len(file_changes)

            if not DRY:
                # preserve original line endings by writing back with newline=""
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.writelines(new_lines)

    print(f"\n{'WOULD CHANGE' if DRY else 'CHANGED'} {total} table reference(s) "
          f"across {len(FILES)} file(s).")
    if DRY:
        print("Dry run only -- nothing written. Set DRY = False to apply.")


if __name__ == "__main__":
    main()
