from __future__ import annotations

from .db import connect


def main() -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 AS ok")
        row = cur.fetchone()
        if row["ok"] != 1:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
