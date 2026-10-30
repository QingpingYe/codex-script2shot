#!/bin/sh
# ensure_node.sh —— 无 Node 环境下的引导脚本（setup 技能专用，POSIX）。
#
# 用法：sh scripts/ensure_node.sh
#
# 行为：复用系统 node / 私有运行时 → 都没有时下载 Node >= 24 的最新 LTS 归档，
#       以 SHASUMS256.txt 校验 sha256 后解压到 <home>/runtime/node-<version>/，
#       输出 JSON（ok / source / version / node_path / npm_path）。
#       目录布局与校验口径与 scripts/setup_bootstrap.mjs 的 ensure-runtime 一致。
# 退出码：0 成功、1 失败。可用 SCRIPT2SHOT_NODE_VERSION 固定要下载的版本（测试用）。
# 本脚本只在 setup 流程中被 AI 调用；MCP 启动器不得自动下载。

set -eu

MIN_MAJOR=24
NODE_DIST_BASE="https://nodejs.org/dist"
NODE_INDEX_URL="$NODE_DIST_BASE/index.json"
SHA_FILE="SHASUMS256.txt"

home_dir=${SCRIPT2SHOT_HOME:-"$HOME/.codex-script2shot"}
runtime_root=$home_dir/runtime

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# curl 优先，wget 兜底；输出到 stdout（大文件用 -o 模式另见 fetch_to）。
http_get() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time "${2:-30}" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - --timeout="${2:-30}" "$1"
  else
    return 127
  fi
}

fetch_to() {
  # $1=url $2=dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 600 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" --timeout=600 "$1"
  else
    return 127
  fi
}

out_json() {
  printf '%s\n' "$1"
}

fail() {
  # $1=code $2=message
  out_json "{\"ok\":false,\"error\":{\"code\":\"$(json_escape "$1")\",\"message\":\"$(json_escape "$2")\"}}"
  exit 1
}

probe_major() {
  raw=$("$1" --version 2>/dev/null || true)
  case "$raw" in
    v[0-9]*)
      major=${raw#v}
      major=${major%%.*}
      printf '%s' "$major"
      ;;
    *) printf '' ;;
  esac
}

report_ok() {
  # $1=source $2=node_path
  node_path=$2
  version_raw=$("$node_path" --version 2>/dev/null | head -n 1)
  version=${version_raw#v}
  node_dir=$(CDPATH= cd "$(dirname "$node_path")" && pwd)
  npm_path=$node_dir/npm
  if [ -f "$node_dir/npm.cmd" ]; then npm_path=$node_dir/npm.cmd; fi
  if [ ! -f "$npm_path" ] && [ -f "$node_dir/bin/npm" ]; then npm_path=$node_dir/bin/npm; fi
  out_json "{\"ok\":true,\"source\":\"$1\",\"version\":\"$(json_escape "$version")\",\"node_path\":\"$(json_escape "$node_path")\",\"npm_path\":\"$(json_escape "$npm_path")\"}"
  exit 0
}

# ① 系统 node。
if command -v node >/dev/null 2>&1; then
  system_node=$(command -v node)
  major=$(probe_major "$system_node")
  if [ -n "$major" ] && [ "$major" -ge "$MIN_MAJOR" ]; then
    report_ok system "$system_node"
  fi
fi

# ② 私有运行时（ensure-runtime 布局；多版本时取目录名字典序最大者，视为最新）。
private_node=""
if [ -d "$runtime_root" ]; then
  for version_dir in $(ls -d "$runtime_root"/node-* 2>/dev/null | sort -r); do
    for inner in $(ls -d "$version_dir"/node-* 2>/dev/null | sort -r); do
      if [ -x "$inner/bin/node" ]; then
        private_node=$inner/bin/node
        break
      fi
    done
    [ -n "$private_node" ] && break
  done
fi
if [ -n "$private_node" ]; then
  major=$(probe_major "$private_node")
  if [ -n "$major" ] && [ "$major" -ge "$MIN_MAJOR" ]; then
    report_ok private "$private_node"
  fi
fi

# ③ 下载并落地最新 LTS。
version=${SCRIPT2SHOT_NODE_VERSION:-}
if [ -z "$version" ]; then
  index=$(http_get "$NODE_INDEX_URL" 30) || \
    fail "NETWORK_BLOCKED" "无法读取 Node 版本索引：$NODE_INDEX_URL"
  version=$(printf '%s' "$index" | tr '{' '\n' | grep -v '"lts":false' | grep -o '"version":"v[0-9][^"]*"' | cut -d'"' -f4 | while read -r candidate; do
    candidate_major=${candidate#v}
    candidate_major=${candidate_major%%.*}
    if [ "$candidate_major" -ge "$MIN_MAJOR" ]; then printf '%s\n' "$candidate"; fi
  done | sort -V | tail -n 1)
  if [ -z "$version" ]; then
    fail "NODE_UNAVAILABLE" "Node 版本索引里没有满足 >= $MIN_MAJOR 的 LTS 版本。"
  fi
fi
case "$version" in
  v*) ;;
  *) version="v$version" ;;
esac
case "$version" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "NODE_UNAVAILABLE" "Node 版本号格式不合法：$version" ;;
esac

os_name=$(uname -s)
arch_name=$(uname -m)
case "$os_name-$arch_name" in
  Darwin-arm64) archive_name="node-$version-darwin-arm64.tar.gz" ;;
  Darwin-x86_64) archive_name="node-$version-darwin-x64.tar.gz" ;;
  Linux-x86_64) archive_name="node-$version-linux-x64.tar.xz" ;;
  Linux-aarch64 | Linux-arm64) archive_name="node-$version-linux-arm64.tar.xz" ;;
  *) fail "NPM_UNAVAILABLE" "当前平台/架构不支持自动补装 Node：$os_name-$arch_name" ;;
esac

archive_url=$NODE_DIST_BASE/$version/$archive_name
checksum_url=$NODE_DIST_BASE/$version/$SHA_FILE
runtime_dir=$runtime_root/node-$version
archive_path=$runtime_dir/$archive_name

mkdir -p "$runtime_dir"
fetch_to "$archive_url" "$archive_path" || \
  fail "NODE_DOWNLOAD_FAILED" "下载 Node 归档失败：$archive_url"
checksums=$(http_get "$checksum_url" 30) || \
  fail "NODE_DOWNLOAD_FAILED" "下载 Node 校验文件失败：$checksum_url"
expected=$(printf '%s' "$checksums" | grep " $archive_name\$" | head -n 1 | cut -d' ' -f1)
if [ -z "$expected" ]; then
  fail "NODE_CHECKSUM_MISMATCH" "校验文件里没有 $archive_name 的 sha256 记录。"
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive_path" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$archive_path" | cut -d' ' -f1)
fi
if [ "$actual" != "$expected" ]; then
  fail "NODE_CHECKSUM_MISMATCH" "Node 归档 sha256 校验失败：$archive_name"
fi

case "$archive_name" in
  *.tar.gz) tar -xzf "$archive_path" -C "$runtime_dir" ;;
  *.tar.xz) tar -xJf "$archive_path" -C "$runtime_dir" ;;
esac
rm -f "$archive_path"

top_dir=""
for candidate in "$runtime_dir"/node-$version-*; do
  if [ -d "$candidate" ]; then top_dir=$candidate; break; fi
done
if [ -z "$top_dir" ]; then
  only=$(ls -d "$runtime_dir"/*/ 2>/dev/null | head -n 1)
  [ -n "$only" ] && top_dir=${only%/}
fi
if [ -z "$top_dir" ] || [ ! -x "$top_dir/bin/node" ] || [ ! -f "$top_dir/bin/npm" ]; then
  fail "NODE_DOWNLOAD_FAILED" "解压后的 Node 运行时缺少 node / npm。"
fi

report_ok private "$top_dir/bin/node"
