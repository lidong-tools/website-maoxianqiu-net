#!/usr/bin/env bash
# ============================================================
# 毛线球 Stage-04 — Agent-01 Runtime/UAT/DB Gate 共享门禁工具
#
# 供以下脚本 source 使用(必须在仓库根目录被调用):
#   scripts/e2e-setup.sh
#   scripts/runtime-blank-db.sh
#   scripts/runtime-upgrade-check.sh(后续)
#
# 提供:
#   - is_ci                     : 是否 CI 环境
#   - get_linked_ref            : 读取 supabase link 的 project ref
#   - detect_production         : 识别 production 数据库(0=生产,1=非生产)
#   - require_destructive_reset : destructive DB reset 安全门(模式+开关+生产防护+交互确认)
#   - require_runtime_envs      : 强校验运行时必备环境变量
#   - record_gate_report        : 向 document/testing/reports/ 追加结构化门禁记录
#
# 设计原则:所有 destructive 操作必须显式声明才能执行,宁可拒绝也不误重置。
# ============================================================

set -euo pipefail

# 仓库根目录(脚本位于 scripts/ 下,父目录即根)
RUNTIME_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------- 环境检测 ----------

# 判断是否 CI 环境(CI 模式下跳过交互确认)
is_ci() {
  [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]
}

# 读取当前 linked Supabase project ref(优先 .temp,其次环境变量)
get_linked_ref() {
  local ref_file="${RUNTIME_REPO_ROOT}/supabase/.temp/project-ref"
  if [ -f "${ref_file}" ]; then
    cat "${ref_file}"
  elif [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
    echo "${SUPABASE_PROJECT_REF}"
  fi
}

# 识别 production 数据库。
# 命中以下任一条件即视为生产(0),任何 destructive 操作必须拒绝:
#   1. project ref / SUPABASE_URL / DATABASE_URL 中出现 prod/production 标识;
#   2. project ref 显式出现在 SUPABASE_PROD_PROJECT_REFS(逗号分隔)中。
detect_production() {
  local ref
  ref="$(get_linked_ref)"
  local targets="${ref:-} ${SUPABASE_URL:-} ${DATABASE_URL:-}"

  # 显式声明:管理员在生产部署前维护此列表
  if [ -n "${SUPABASE_PROD_PROJECT_REFS:-}" ]; then
    local r
    IFS=',' read -ra _prod_refs <<< "${SUPABASE_PROD_PROJECT_REFS}"
    for r in "${_prod_refs[@]}"; do
      [ -n "${r}" ] && [ "${r}" = "${ref}" ] && return 0
    done
  fi

  # 名称启发式:含生产标识即防御性拒绝
  case "${targets}" in
    *production* | *-prod-* | *_prod_* | *.prod.*)
      return 0
      ;;
  esac
  return 1
}

# ---------- 环境变量强校验 ----------

# 强校验运行时必备环境变量(缺失即退出)
# 用法: require_runtime_envs E2E_USERNAME DATABASE_URL ...
require_runtime_envs() {
  local name
  for name in "$@"; do
    eval "local value=\"\${${name}:-}\""
    if [ -z "${value}" ]; then
      echo "错误: 缺少环境变量 ${name}(先设置后再运行)" >&2
      exit 1
    fi
  done
}

# ---------- destructive reset 安全门 ----------

# 要求显式允许 destructive DB reset。
# RUNTIME_DB_MODE 允许值:local / staging-reset / upgrade-rehearsal
#   - local / staging-reset 允许 reset;
#   - upgrade-rehearsal 明确禁止 reset(必须基于既有快照升级);
# 必须先设置 ALLOW_DESTRUCTIVE_DB_RESET=YES,且数据库不得被识别为 production。
require_destructive_reset() {
  local mode="${RUNTIME_DB_MODE:-local}"
  case "${mode}" in
    local | staging-reset)
      : ;;
    upgrade-rehearsal)
      echo "错误: RUNTIME_DB_MODE=upgrade-rehearsal 不允许 db reset(应基于既有 schema 快照升级)" >&2
      exit 1
      ;;
    *)
      echo "错误: 未知 RUNTIME_DB_MODE='${mode}' (允许值: local | staging-reset | upgrade-rehearsal)" >&2
      exit 1
      ;;
  esac

  if [ "${ALLOW_DESTRUCTIVE_DB_RESET:-NO}" != "YES" ]; then
    echo "错误: destructive DB reset 必须显式设置 ALLOW_DESTRUCTIVE_DB_RESET=YES" >&2
    echo "      这是防误重置的保护开关,绝不默认开启" >&2
    exit 1
  fi

  local ref
  ref="$(get_linked_ref)"
  if detect_production; then
    echo "错误: 检测到 production 数据库(project ref='${ref:-未知}', SUPABASE_URL='${SUPABASE_URL:-未设置}')" >&2
    echo "      已拒绝执行 destructive reset" >&2
    exit 1
  fi

  if ! is_ci; then
    read -r -p "确认将对 linked Supabase 项目(ref='${ref:-未知}')执行 destructive reset 并继续? [y/N] " _ans
    case "${_ans}" in
      y | Y) : ;;
      *)
        echo "已取消"
        exit 1
        ;;
    esac
  fi
}

# ---------- 门禁报告 ----------

# 向 document/testing/reports/ 写入结构化门禁记录(追加模式)。
# 用法: record_gate_report <gate_name> <status> <summary...>
record_gate_report() {
  local gate_name="${1:?gate_name 必填}"
  local status="${2:?status 必填}"
  shift 2
  local report_dir="${RUNTIME_REPO_ROOT}/document/testing/reports"
  mkdir -p "${report_dir}"
  local report_file="${report_dir}/${gate_name}.md"
  {
    echo "## $(date '+%Y-%m-%d %H:%M:%S %z') — ${status}"
    echo
    echo "\`\`\`text"
    echo "$*"
    echo "\`\`\`"
    echo
  } >> "${report_file}"
  echo "[runtime-common] 已记录 gate=${gate_name} status=${status} → ${report_file}"
}
