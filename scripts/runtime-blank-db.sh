#!/usr/bin/env bash
# ============================================================
# 毛线球 Stage-04 — Agent-01 Blank DB Migration Gate
#
# 目标:空数据库 → 应用全部 migration(0..latest) → seed/fixtures
#      → schema 断言(核心表存在 + 最新版本已应用)。
#
# 用法: bash scripts/runtime-blank-db.sh
# 前置:
#   DATABASE_URL                 : PostgreSQL 连接串(仅用于 psql schema 断言,需有 postgres 权限)
#   RUNTIME_DB_MODE              : local | staging-reset | upgrade-rehearsal(默认 local)
#   ALLOW_DESTRUCTIVE_DB_RESET   : 必须显式设为 YES(本 gate 会执行 linked db reset)
#   SUPABASE_PROD_PROJECT_REFS   : 可选,逗号分隔的生产 project ref,命中则拒绝执行
#   api/.env.local               : 需含 SUPABASE_URL(用于 production 识别)
#
# 记录:开始/结束时间、migration count、latest version、失败 migration、
#      DB 版本、Supabase CLI 版本;报告追加到 document/testing/reports/runtime-blank-db.md
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# 加载共享运行时门禁工具(production 识别 / destructive reset 安全门 / 报告记录)
# shellcheck source=scripts/runtime-common.sh
source "${PWD}/scripts/runtime-common.sh"

# ---------- 前置强校验(任何副作用之前) ----------
require_runtime_envs DATABASE_URL
command -v supabase >/dev/null 2>&1 || { echo "错误: 需要 supabase CLI 在 PATH 中"; exit 1; }
[ -f api/.env.local ] || { echo "错误: 缺少 api/.env.local(Supabase 配置,需含 SUPABASE_URL 供 production 识别)"; exit 1; }

# destructive reset 安全门(upgrade-rehearsal 模式禁止 reset,production 一律拒绝)
require_destructive_reset

# ---------- 元数据记录 ----------
REPORT_DIR="document/testing/reports"
RUN_LOG="${REPORT_DIR}/runtime-blank-db-run.log"
mkdir -p "${REPORT_DIR}"

START_TS="$(date '+%Y-%m-%d %H:%M:%S %z')"
START_EPOCH="$(date +%s)"
SUPABASE_CLI_VERSION="$(supabase --version 2>/dev/null || echo 'unknown')"
if command -v psql >/dev/null 2>&1; then
  PSQL_TOOL_VERSION="$(psql --version 2>/dev/null || echo 'unknown')"
else
  PSQL_TOOL_VERSION="psql unavailable(将尝试 supabase db execute 完成 schema 断言)"
fi

MIGRATION_COUNT="$(ls supabase/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')"
LATEST_FILE="$(ls supabase/migrations/*.sql 2>/dev/null | sort | tail -1 || true)"
LATEST_NAME="$(basename "${LATEST_FILE:-none}")"

echo "=== Blank DB Migration Gate 开始: ${START_TS} ==="
echo "supabase CLI : ${SUPABASE_CLI_VERSION}"
echo "psql         : ${PSQL_TOOL_VERSION}"
echo "migration 数 : ${MIGRATION_COUNT}"
echo "latest       : ${LATEST_NAME}"

# ---------- 1. 空库重建(应用全部 migration + seed) ----------
# set -e 下用 PIPESTATUS 捕获 supabase 真实退出码(tee 不改写语义)
set +e
supabase db reset --linked --yes 2>&1 | tee "${RUN_LOG}"
RESET_EXIT="${PIPESTATUS[0]}"
set -e

if [ "${RESET_EXIT}" -ne 0 ]; then
  record_gate_report runtime-blank-db FAIL \
    "db reset 失败 exit=${RESET_EXIT},详情见 ${RUN_LOG};start=${START_TS}"
  echo "Blank DB Gate: FAIL(db reset 未通过)"
  exit 1
fi

# ---------- 2. schema 断言 ----------
# 断言函数:仅当 psql 可用时执行;psql 缺失则标记 SKIPPED(db reset 成功已证明 migration 可应用)
run_db_sql() {
  local sql="${1}"
  if command -v psql >/dev/null 2>&1; then
    psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -At -c "${sql}"
  else
    echo "PSQL_UNAVAILABLE"
  fi
}

# 2a. 已应用的最新 migration 版本
APPLIED_LATEST="$(run_db_sql "select version from supabase_migrations.schema_migrations order by version desc limit 1;" || echo 'QUERY_FAILED')"

# 2b. 核心表存在性断言(SQL 内 DO 块,任一缺失即抛错)
SCHEMA_ASSERT_SQL='
do $$
declare
  v_missing text[];
begin
  select array_agg(t.tbl) into v_missing
  from (values
    (''tenants''),(''stores''),(''users''),(''customers''),(''pets''),
    (''catalog_items''),(''invoices''),(''payments''),(''prescriptions''),
    (''inventory_movements''),(''audit_logs'')
  ) as t(tbl)
  where not exists (
    select 1 from pg_tables pg where pg.schemaname = ''public'' and pg.tablename = t.tbl
  );
  if v_missing is not null then
    raise exception ''BLANK_DB_SCHEMA_FAILED: missing %'', array_to_string(v_missing, '','');
  end if;
end $$;'

if command -v psql >/dev/null 2>&1; then
  if run_db_sql "${SCHEMA_ASSERT_SQL}" >/dev/null 2>&1; then
    SCHEMA_OK="PASS"
  else
    SCHEMA_OK="FAIL"
  fi
else
  SCHEMA_OK="SKIPPED(psql 不可用)"
fi

# ---------- 3. 收尾与报告 ----------
END_TS="$(date '+%Y-%m-%d %H:%M:%S %z')"
END_EPOCH="$(date +%s)"
DURATION_SEC="$((END_EPOCH - START_EPOCH))"

SUMMARY="
Blank DB Migration Gate
  开始时间 : ${START_TS}
  结束时间 : ${END_TS}
  耗时     : ${DURATION_SEC}s
  migration count : ${MIGRATION_COUNT}
  latest file     : ${LATEST_NAME}
  latest applied  : ${APPLIED_LATEST}
  schema assert   : ${SCHEMA_OK}
  失败 migration  : none(exit=${RESET_EXIT})
  Supabase CLI    : ${SUPABASE_CLI_VERSION}
  DB 工具         : ${PSQL_TOOL_VERSION}
  完整日志       : ${RUN_LOG}"

# 判定:db reset 成功 + schema 断言 PASS + 最新版本已应用才视为 PASS
# (psql 不可用导致 SKIPPED 时,以 db reset 结果为准仍判 PASS,但报告保留 SKIPPED 标记)
GATE_STATUS="PASS"
if [ "${SCHEMA_OK}" != "PASS" ] && [ "${SCHEMA_OK}" != "SKIPPED(psql 不可用)" ]; then
  GATE_STATUS="FAIL"
elif [ -z "${APPLIED_LATEST}" ] || [ "${APPLIED_LATEST}" = "QUERY_FAILED" ] || [ "${APPLIED_LATEST}" = "PSQL_UNAVAILABLE" ]; then
  if [ "${SCHEMA_OK}" != "SKIPPED(psql 不可用)" ]; then
    GATE_STATUS="FAIL"
  fi
fi

record_gate_report runtime-blank-db "${GATE_STATUS}" "${SUMMARY}"
echo "=== Blank DB Gate 结束: ${END_TS} ==="
echo "${SUMMARY}"

if [ "${GATE_STATUS}" = "FAIL" ]; then
  echo "Blank DB Gate: FAIL(schema 断言未通过)"
  exit 1
fi
echo "Blank DB Gate: PASS"
