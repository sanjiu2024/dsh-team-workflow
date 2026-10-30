#!/usr/bin/env node
/**
 * 验「dsh-purge 的提示词注入有没有重复」。
 *
 * 背景（2026-10-30 实测）：`addPromptSection` 被 apply() 和 prepareAssemble() 各调一次，
 * 两处宿主代理不同 → 同名 section 挂两份 → 系统提示里出现两份逐字相同的
 * `~/.dsh/prompt-inject.md`（21803 字符一份）。会话日志 `type=system/message` 那行
 * 整行 68977 字符、同一特征串出现 2 次，地板白多付约 6.5k token。
 *
 * 这个脚本只读，回答三件事：
 *   ① purge 内部日志里，同一时刻的 inject.read 是几条（重复时是 3 条一组）；
 *   ② 最近一条 system/message 里，注入特征串出现几次、整行多少字符；
 *   ③ 补丁文件还在不在（重启/更新后可能被覆盖）。
 *
 * 用法：node scripts/check-purge-inject.mjs [会话目录关键字]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const PURGE_PKG = path.join(HOME, "profiles", "desktop", "node_modules", "dsh-purge");
const MARK = "Little Code Sauce — a SANDBOX task executor";

const say = (s) => console.log(s);
let bad = 0;

// ③ 补丁还在不在
say("① 补丁状态");
const idx = path.join(PURGE_PKG, "lib", "index.js");
if (fs.existsSync(idx)) {
  const src = fs.readFileSync(idx, "utf8");
  const patched = src.includes("PURGE_SECTIONS_ON");
  say(`   ${patched ? "✓" : "✗"} 幂等补丁${patched ? "在" : "不见了（被更新覆盖？）"}`);
  if (!patched) bad++;
} else {
  say(`   ✗ 找不到 ${idx}`);
  bad++;
}

// ① 内部日志：inject.read 的突发条数
say("\n② purge 内部日志（每次请求应该只 1 条 inject.read）");
const logFile = path.join(os.tmpdir(), "dsh-purge-desktop.log");
if (!fs.existsSync(logFile)) {
  say("   ⚠ 没有日志（purge 没跑过？）");
} else {
  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("[inject.read]"));
  // 按秒分组，数每组几条
  const bursts = new Map();
  for (const l of lines) {
    const ts = l.slice(0, 19); // 秒级
    bursts.set(ts, (bursts.get(ts) ?? 0) + 1);
  }
  const recent = [...bursts.entries()].slice(-12);
  const counts = recent.map(([, n]) => n);
  const worst = counts.length ? Math.max(...counts) : 0;
  for (const [ts, n] of recent) say(`   ${ts}  ${n} 条`);
  say(`   最近 12 次请求里最多 ${worst} 条 → ${worst <= 1 ? "✓ 没重复" : worst === 2 ? "✗ 两份" : `✗ ${worst} 份`}`);
  if (worst > 1) bad++;
}

// ② 会话日志里 system/message 的实际大小
say("\n③ 最近一条 system/message 的实际内容");
const sessRoot = path.join(HOME, "sessions");
const hits = [];
if (fs.existsSync(sessRoot)) {
  for (const grp of fs.readdirSync(sessRoot)) {
    const gd = path.join(sessRoot, grp);
    let names = [];
    try { names = fs.readdirSync(gd); } catch { continue; }
    for (const s of names) {
      const f = path.join(gd, s, "session.v4.jsonl.zstd");
      if (fs.existsSync(f)) hits.push([f, fs.statSync(f).mtimeMs]);
    }
  }
}
hits.sort((a, b) => b[1] - a[1]);
if (hits.length === 0) {
  say("   ⚠ 找不到会话日志");
} else {
  const [f] = hits[0];
  const buf = fs.readFileSync(f);
  const parts = [];
  let pos = 0;
  while (pos < buf.length - 4) {
    if (buf.readUInt32LE(pos) !== 0xfd2fb528) break;
    let next = pos + 4;
    while (next < buf.length - 3 && buf.readUInt32LE(next) !== 0xfd2fb528) next++;
    if (next >= buf.length - 3) next = buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(pos, next)).toString("utf8")); } catch { break; }
    pos = next;
  }
  let last = null;
  for (const l of parts.join("").split("\n")) {
    if (!l.includes(MARK)) continue;
    let e = null;
    try { e = JSON.parse(l); } catch { continue; }
    // 只认真正的系统消息：别的类型（tool/result、assistant/message）里也可能引用这段文字
    if (e.type !== "system/message") continue;
    last = l;
  }
  if (!last) {
    say("   ⚠ 这份会话里没有该系统提示（换个会话再跑，或尾部还没落盘）");
  } else {
    const n = last.split(MARK).length - 1;
    let e = null;
    try { e = JSON.parse(last); } catch { /* 保持 null */ }
    say(`   seq=${e?.seq ?? "?"}  整行 ${last.length} 字符  特征串×${n}`);
    say(`   → ${n <= 1 ? "✓ 只注入一次" : `✗ 注入 ${n} 次（多付约 ${Math.round(((n - 1) * 21803) / 3.4 / 100) / 10}k token）`}`);
    if (n > 1) bad++;
  }
}

say(`\n===== ${bad === 0 ? "全部通过 ✓" : `${bad} 项有问题 ✗`} =====`);
process.exit(bad === 0 ? 0 : 1);
