CREATE USER if not exists public IDENTIFIED WITH no_password
  DEFAULT DATABASE WOT
  SETTINGS
    add_http_cors_header = 1,
    max_execution_time = 600,
    max_temporary_columns = 100,
    max_memory_usage = '2G',
    max_query_size = '10M',
    readonly = 2;

CREATE QUOTA if not exists public
  KEYED BY forwarded_ip_address
    FOR RANDOMIZED INTERVAL 1 MINUTE MAX queries = 240, result_rows = 100000, execution_time = 20,
    FOR RANDOMIZED INTERVAL 1 HOUR MAX queries = 2000, result_rows = '2M', execution_time = 600,
    FOR RANDOMIZED INTERVAL 1 DAY MAX queries = 5000, result_rows = '10M', execution_time = 2000
TO public;

GRANT SELECT ON WOT.Event_OnBattleStart TO public;
GRANT SELECT ON WOT.Event_OnBattleResult TO public;
GRANT SELECT ON WOT.Event_OnShot TO public;
GRANT SELECT ON WOT.Event_OnLootboxOpen TO public;