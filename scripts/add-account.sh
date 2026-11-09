#!/usr/bin/env bash
# 给第二个（及以后）账号开一个独立实例：独立进程、独立数据目录、独立端口。
# 用法：
#   sudo ./scripts/add-account.sh add 同学A          # 自动分配端口
#   sudo ./scripts/add-account.sh add 同学A 8901     # 指定端口
#   sudo ./scripts/add-account.sh list
#   sudo ./scripts/add-account.sh remove 同学A
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/ocs-server}
DATA_ROOT=${DATA_ROOT:-/opt/ocs-data}
ENV_DIR=${ENV_DIR:-/etc/ocs-server}
UNIT_TEMPLATE=${UNIT_TEMPLATE:-ocs-server@.service}

die() { echo "错误：$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 sudo 运行"

installed() { [[ -d "$APP_DIR/src" ]]; }

port_of() { grep -h '^OCS_PORT=' "$ENV_DIR/$1.env" 2>/dev/null | cut -d= -f2; }

next_port() {
  local max=8899 p
  for f in "$ENV_DIR"/*.env; do
    [[ -e "$f" ]] || continue
    p=$(grep -h '^OCS_PORT=' "$f" | cut -d= -f2 || true)
    if [[ "$p" =~ ^[0-9]+$ ]] && (( p > max )); then max=$p; fi
  done
  echo $((max + 1))
}

lan_ip() {
  hostname -I 2>/dev/null | awk '{print $1}'
}

cmd_add() {
  local name=${1:-} port=${2:-}
  [[ -n "$name" ]] || die "用法：add <实例名> [端口]"
  if [[ ! "$name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    die "实例名只能用英文、数字、下划线、短横线（中文请用拼音，如 tongxueB）"
  fi
  if [[ "$name" = "main" ]]; then die "main 是默认实例的保留名，换一个"; fi
  installed || die "找不到 $APP_DIR/src，请先在 $APP_DIR 部署程序"
  if [[ -f "$ENV_DIR/$name.env" ]]; then die "实例 $name 已存在（$ENV_DIR/$name.env）"; fi

  port=${port:-$(next_port)}
  [[ "$port" =~ ^[0-9]+$ ]] || die "端口必须是数字"

  mkdir -p "$ENV_DIR" "$DATA_ROOT/$name"
  cat > "$ENV_DIR/$name.env" <<EOF
# OCS 实例「$name」
OCS_PORT=$port
EOF

  if [[ ! -f "/etc/systemd/system/$UNIT_TEMPLATE" ]]; then
    cp "$APP_DIR/deploy/$UNIT_TEMPLATE" "/etc/systemd/system/$UNIT_TEMPLATE"
  fi
  systemctl daemon-reload
  systemctl enable --now "ocs-server@$name" >/dev/null

  sleep 1
  if systemctl is-active --quiet "ocs-server@$name"; then
    echo
    echo "实例 $name 已启动"
    echo "  地址：http://$(lan_ip):$port"
    echo "  数据：$DATA_ROOT/$name"
    echo
    echo "打开上面的地址，添加课程任务并在这个实例里登录一次即可。"
    echo "这个实例的 AI 配置和登录态都是独立的，和别人互不影响。"
  else
    die "启动失败，看日志：journalctl -u ocs-server@$name -n 50 --no-pager"
  fi
}

cmd_list() {
  if ! ls "$ENV_DIR"/*.env >/dev/null 2>&1; then
    echo "还没有额外实例。默认实例用 ocs-server.service，端口 8899。"
    return
  fi
  printf "%-16s %-8s %-10s %s\n" 实例 端口 状态 数据目录
  for f in "$ENV_DIR"/*.env; do
    local n p s
    n=$(basename "$f" .env)
    p=$(port_of "$n")
    s=$(systemctl is-active "ocs-server@$n" 2>/dev/null || echo inactive)
    printf "%-16s %-8s %-10s %s\n" "$n" "$p" "$s" "$DATA_ROOT/$n"
  done
}

cmd_remove() {
  local name=${1:-}
  [[ -n "$name" ]] || die "用法：remove <实例名>"
  [[ -f "$ENV_DIR/$name.env" ]] || die "实例 $name 不存在"
  read -rp "删除实例 $name？登录态和任务都会丢，无法恢复。[y/N] " ok
  [[ "$ok" =~ ^[Yy]$ ]] || { echo "已取消"; exit 0; }
  systemctl disable --now "ocs-server@$name" >/dev/null 2>&1 || true
  rm -f "$ENV_DIR/$name.env"
  rm -rf "${DATA_ROOT:?}/$name"
  systemctl daemon-reload
  echo "已删除 $name"
}

case "${1:-}" in
  add)    shift; cmd_add "$@" ;;
  list|ls) cmd_list ;;
  remove|rm) shift; cmd_remove "$@" ;;
  *) cat <<EOF
用法：
  sudo $0 add <实例名> [端口]     新建一个账号实例
  sudo $0 list                    看现有实例
  sudo $0 remove <实例名>         删除实例（含登录态）

默认实例（第一个账号）就是 ocs-server.service，端口 8899。
EOF
     ;;
esac
