from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

from .settings import settings


def connect() -> psycopg.Connection:
    return psycopg.connect(
        host=settings.db_host,
        port=settings.db_port,
        dbname=settings.db_name,
        user=settings.db_user,
        password=settings.db_password,
        autocommit=False,
        row_factory=dict_row,
    )


@contextmanager
def ingestion_run(source: str, job_name: str, metadata: dict[str, Any] | None = None) -> Iterator[dict[str, Any]]:
    conn = connect()
    run: dict[str, Any] = {"id": None, "records_read": 0, "records_written": 0}
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ops.ingestion_runs(source, job_name, metadata)
                VALUES (%s, %s, %s::jsonb)
                RETURNING id
                """,
                (source, job_name, json.dumps(metadata or {})),
            )
            run["id"] = cur.fetchone()["id"]
        conn.commit()

        yield run

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE ops.ingestion_runs
                SET finished_at = now(), status = 'success', records_read = %s, records_written = %s
                WHERE id = %s
                """,
                (run["records_read"], run["records_written"], run["id"]),
            )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if run["id"] is not None:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE ops.ingestion_runs
                    SET finished_at = now(), status = 'error', records_read = %s,
                        records_written = %s, error_message = %s
                    WHERE id = %s
                    """,
                    (run["records_read"], run["records_written"], str(exc)[:4000], run["id"]),
                )
            conn.commit()
        raise
    finally:
        conn.close()


def mark_interrupted_runs() -> int:
    """Close runs left 'running' when the previous worker was stopped/redeployed."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ops.ingestion_runs
            SET finished_at = now(),
                status = 'interrupted',
                error_message = COALESCE(error_message, 'Worker stopped before job completion')
            WHERE status = 'running'
            """
        )
        count = cur.rowcount
        conn.commit()
        return count


def get_cursor(source: str, job_name: str, cursor_name: str = "default") -> str | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT cursor_value FROM ops.ingestion_cursor
            WHERE source=%s AND job_name=%s AND cursor_name=%s
            """,
            (source, job_name, cursor_name),
        )
        row = cur.fetchone()
        return row["cursor_value"] if row else None


def set_cursor(source: str, job_name: str, value: str, cursor_name: str = "default") -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ops.ingestion_cursor(source, job_name, cursor_name, cursor_value, updated_at)
            VALUES (%s,%s,%s,%s,now())
            ON CONFLICT (source, job_name, cursor_name)
            DO UPDATE SET cursor_value=EXCLUDED.cursor_value, updated_at=now()
            """,
            (source, job_name, cursor_name, value),
        )
        conn.commit()


def seconds_since_last_success(source: str, job_name: str) -> float | None:
    """Return the age of the most recent successful run, or None if none exists."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT extract(epoch FROM (now() - finished_at)) AS age_seconds
            FROM ops.ingestion_runs
            WHERE source=%s AND job_name=%s AND status='success' AND finished_at IS NOT NULL
            ORDER BY finished_at DESC
            LIMIT 1
            """,
            (source, job_name),
        )
        row = cur.fetchone()
        if not row or row["age_seconds"] is None:
            return None
        return max(0.0, float(row["age_seconds"]))
