BEGIN;

INSERT INTO ads.account(account_id,marketplace_id,country_code,currency)
VALUES('history-test-account','A1AM78C64UM0Y8','MX','MXN');

INSERT INTO ads.report_content(
    content_sha256,encoding,row_count,uncompressed_bytes,compressed_bytes,payload
) VALUES (
    repeat('a',64),'GZIP_CANONICAL_JSON_ROWS_V1',0,2,1,'\x00'::bytea
);

INSERT INTO ads.report_content_observation(
    account_id,report_id,report_grain,start_date,end_date,source_generated_at,
    observed_at,content_sha256,row_count
) VALUES (
    'history-test-account','history-test-report','product','2026-09-01','2026-09-01',
    '2026-09-02T00:00:00Z','2026-09-02T00:01:00Z',repeat('a',64),0
);

DO $history$
BEGIN
    IF (SELECT count(*) FROM ads.report_content_observation) <> 1 THEN
        RAISE EXCEPTION 'report content observation did not survive round trip';
    END IF;
    BEGIN
        UPDATE ads.report_content_observation
        SET row_count=1
        WHERE report_id='history-test-report';
        RAISE EXCEPTION 'report content observation mutation was not blocked';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'report content observation mutation was not blocked' THEN
            RAISE;
        END IF;
    END;
    BEGIN
        DELETE FROM ads.report_content WHERE content_sha256=repeat('a',64);
        RAISE EXCEPTION 'report content mutation was not blocked';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'report content mutation was not blocked' THEN
            RAISE;
        END IF;
    END;
END
$history$;

ROLLBACK;
