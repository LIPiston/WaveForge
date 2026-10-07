#!/usr/bin/env bash
# 测试 .github/workflows/nightly.yml 里 changelog 生成那一段（工作流第 54-125 行）的行为。
# 只读仓库（git log / git tag / git describe），只在 <repo>/tmp/ 下写 changelog.test.md。
#
# 用法（在 Git Bash 里、仓库根目录执行）：
#   bash scripts/test-nightly-changelog.sh              # 用真实北京日期
#   bash scripts/test-nightly-changelog.sh 20261007     # 模拟某个构建日期
#   FORCE=true bash scripts/test-nightly-changelog.sh   # 模拟 force 触发
set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT" || exit 1
mkdir -p tmp
OUT="tmp/changelog.test.md"

echo "== 环境 =="
echo "repo root       : $ROOT"
git --version
echo "北京日期        : $(TZ=Asia/Shanghai date +%Y%m%d)"
echo

# ========== 以下与 workflow 第 55-125 行保持一致 ==========
# 北京时间日期作为构建标识
if [ $# -ge 1 ]; then
  DATE="$1"
else
  DATE=$(TZ=Asia/Shanghai date +%Y%m%d)
fi
NIGHTLY_TAG="nightly"

# 读取基础版本（package.json），不改仓库，只在工作区拼出 nightly 版本
BASE_VERSION=$(node -p "require('./package.json').version")
NIGHTLY_VERSION="${BASE_VERSION}-nightly.${DATE}"

# changelog 覆盖「上一个正式版 tag」之后的全部提交（跨多个 nightly 累积，不因 nightly 覆盖而截断）；
# 若仓库里还没有任何正式版 tag，则回退最近 50 条提交。
LAST_NIGHTLY=$(git tag -l 'nightly' --sort=-creatordate | head -1)
LAST_STABLE=$(git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null \
  || git tag -l 'v*' --sort=-v:refname | head -1)
RANGE="${LAST_STABLE:+${LAST_STABLE}..HEAD}"

# 无新增提交判定（仅当存在上一个 nightly tag 且非 force 时生效）
HAS_CHANGES="true"
if [ "${FORCE:-false}" != "true" ] && [ -n "$LAST_NIGHTLY" ]; then
  if [ "$(git rev-parse "$LAST_NIGHTLY")" = "$(git rev-parse HEAD)" ]; then
    HAS_CHANGES="false"
  fi
fi

# 生成 changelog（排除 merge 提交；按提交日期分组，最新一天默认展开、其余日期收起为 <details>）
if [ -n "$RANGE" ]; then
  CHANGELOG_SCOPE="自上个正式版 ${LAST_STABLE} 起"
  LOG=$(TZ=Asia/Shanghai git log $RANGE --no-merges --date=format-local:%Y-%m-%d \
    --pretty=format:'%ad|%s (%h)' 2>/dev/null \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' || true)
else
  CHANGELOG_SCOPE="暂无正式版 tag，最近 50 条提交"
  LOG=$(TZ=Asia/Shanghai git log -50 --no-merges --date=format-local:%Y-%m-%d \
    --pretty=format:'%ad|%s (%h)' 2>/dev/null \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' || true)
fi

{
  echo "# WaveForge Nightly ${DATE}"
  echo ""
  echo "**版本号：${NIGHTLY_VERSION}（基础 ${BASE_VERSION} + 构建日期，非正式发版，不自动升级版本号）**"
  echo ""
  echo "## 代码变动（${CHANGELOG_SCOPE}）"
  echo ""
  if [ -z "$LOG" ]; then
    echo "无新增提交"
  else
    printf '%s\n' "$LOG" | awk -F'|' '
      {
        d = $1
        rest = substr($0, length(d) + 2)
        if (!(d in count)) order[++n] = d
        count[d]++
        lines[d] = lines[d] "- " rest "\n"
      }
      END {
        printf "共 %d 个提交，按提交日期倒序分组；点击日期展开该日提交。\n\n", NR
        for (i = 1; i <= n; i++) {
          d = order[i]
          if (i == 1) {
            printf "### %s（%d 个提交）\n\n%s\n", d, count[d], lines[d]
          } else {
            printf "<details>\n<summary>%s（%d 个提交）</summary>\n\n%s\n</details>\n\n", d, count[d], lines[d]
          }
        }
      }'
  fi
  echo ""
  echo "---"
  echo "⚠️ 自动构建的每日测试版本，可能不稳定。仅用于测试，不推送 update.json，不影响正式版检查更新。"
} > "$OUT"
# ========== workflow 片段结束 ==========

echo "== 元信息（等价于写入 \$GITHUB_OUTPUT 的值）=="
echo "nightly_tag     = ${NIGHTLY_TAG}"
echo "nightly_version = ${NIGHTLY_VERSION}"
echo "has_changes     = ${HAS_CHANGES}"
echo "LAST_NIGHTLY    = ${LAST_NIGHTLY:-<无>}"
echo "LAST_STABLE     = ${LAST_STABLE:-<无>}"
echo "RANGE           = ${RANGE:-<无，回退 -50>}"
echo

echo "== 自检 =="
LOG_LINES=$(printf '%s\n' "$LOG" | grep -c . || true)
UNIQ_DAYS=$(printf '%s\n' "$LOG" | cut -d'|' -f1 | sort -u | grep -c . || true)
DETAILS=$(grep -c '<details>' "$OUT" || true)
SUM=$(grep -c '<summary>' "$OUT" || true)
H3=$(grep -c '^### ' "$OUT" || true)
ITEMS=$(grep -c '^- ' "$OUT" || true)

echo "changelog 文件          : ${OUT}"
echo "提交数 (LOG 非空行)     : ${LOG_LINES}"
echo "日期分组数              : ${UNIQ_DAYS}"
echo "### 标题数（应为 1）    : ${H3}"
echo "<details> 数（应 = 分组数 - 1）: ${DETAILS}"
echo "<summary> 数（应 = details）  : ${SUM}"
echo "列表项 '- ' 数（应 = 提交数）  : ${ITEMS}"
echo "总行数                  : $(wc -l < "$OUT" | tr -d ' ')"
echo

echo "== 断言 =="
FAIL=0
[ "$H3" = "1" ] || { echo "FAIL: ### 标题应为 1 个，实际 ${H3}"; FAIL=1; }
[ "$DETAILS" = "$SUM" ] || { echo "FAIL: details(${DETAILS}) 与 summary(${SUM}) 不配平"; FAIL=1; }
if [ "${UNIQ_DAYS:-0}" -gt 1 ]; then
  [ "$DETAILS" = "$((UNIQ_DAYS - 1))" ] || { echo "FAIL: details 应为 分组数-1 = $((UNIQ_DAYS - 1))，实际 ${DETAILS}"; FAIL=1; }
fi
[ "$LOG_LINES" = "$ITEMS" ] || { echo "FAIL: 提交数(${LOG_LINES}) 与列表项(${ITEMS}) 不一致"; FAIL=1; }

if printf '%s\n' "$LOG" | grep -qP '[\x{4e00}-\x{9fff}]' 2>/dev/null; then
  echo "OK  : 中文 subject 正常（匹配到 CJK 字符）"
else
  echo "WARN: 未匹配到中文 subject（若确实无中文或 grep 不支持 -P 则忽略）"
fi

if [ -n "${RANGE:-}" ]; then
  PIPE_COUNT=$(git log "$RANGE" --no-merges --pretty=format:'%s' 2>/dev/null | grep -c '|' || true)
  echo "INFO: 原始 subject 含 '|' 的提交数 = ${PIPE_COUNT}（rest 用 substr 截取，后半段不应丢失）"
  if [ "${PIPE_COUNT:-0}" -gt 0 ]; then
    RAW=$(git log "$RANGE" --no-merges --pretty=format:'%s' 2>/dev/null | grep '|' | head -1)
    if grep -qF -- "$(printf '%s' "$RAW" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')" "$OUT"; then
      echo "OK  : 含 '|' 的 subject 在 changelog 中完整保留"
    else
      echo "FAIL: 含 '|' 的 subject 被截断：$RAW"
      FAIL=1
    fi
  fi
fi

# 转义检查：changelog 正文里不应出现未转义的裸 '<' / '>'（排除我们自己的 <details>/<summary> 标签）
RAW_LT=$(grep -c '<' "$OUT" || true)
echo "INFO: 含 '<' 的行数 = ${RAW_LT}（应全部来自 <details>/<summary>）"
echo
if [ "$FAIL" = "0" ]; then
  echo "== 结果：全部通过 =="
else
  echo "== 结果：存在失败项 =="
fi

echo
echo "== 预览（前 30 行）=="
head -30 "$OUT"
echo
echo "== 预览（最后 5 行）=="
tail -5 "$OUT"

exit "$FAIL"
