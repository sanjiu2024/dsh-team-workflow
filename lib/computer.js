/**
 * 操控电脑（computer use，REQ-002）：截屏看屏幕 + 鼠标键盘注入 + 操控期锁鼠标。
 *
 * 参考 Anthropic computer use 的动作集与「模型只发指令、宿主执行」架构
 * （调研结论：Codex 没有操控电脑插件，见 docs/requirements/REQ-002 §5）。
 *
 * 架构（零 npm 依赖）：
 *   - 单个常驻 PowerShell 守护进程（daemon.ps1，启动时写到临时目录）：
 *     装 WH_MOUSE_LL/WH_KEYBOARD_LL 钩子（锁鼠标）+ SendInput 注入 + 截图。
 *     与宿主之间用**文件 spool**（in/*.cmd → out/*.out）通信 —— 不用线程、
 *     不用行协议，超时只需弃单，没有流错位问题。
 *   - 锁鼠标：armed 时，钩子放行 dwExtraInfo == MAGIC 的注入事件（AI），
 *     拦截其余真实事件（人）。Ctrl+Alt+L 紧急解锁 → 本插件生命周期内拒操作。
 *   - 审批：execute 内主动 ctx.get("approval").request()，会话级 confirmed
 *     集合实现「首次问、本会话放行」；无审批服务 / rejected / cancelled /
 *     unavailable 一律拒绝（fail-safe）。
 *   - 截图：daemon 产出 PNG → attachments.saveImage → render 返回
 *     [text, image] ContentBlock（模型直接看到屏幕；模型路由不支持 image 时拒绝）。
 *
 * fail-safe：钩子进程死 = 鼠标自动解锁（外部进程天然 fail-open）；
 * 启动失败只报错不硬扛；非 Windows 不注册任何工具。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { toParameterSchema } from "./util.js";

export const COMPUTER_DEFAULTS = {
	/** 默认启用（1.7.0 起，用户要求；enabled:false 可关）。 */
	enabled: true,
	/** 操控空闲多久把鼠标还给人（毫秒）。 */
	idleUnlockMs: 15000,
	/** 守护进程启动（含 C# 编译）超时。 */
	startTimeoutMs: 30000,
	/** 单条命令超时；超时视为守护进程中毒，杀掉重启。 */
	runTimeoutMs: 15000,
	/** 截图命令超时（大屏 PNG 编码更慢）。 */
	shotTimeoutMs: 30000,
};

export const COMPUTER_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	idleUnlockMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	startTimeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	runTimeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	shotTimeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
};

/** 注入标记：SendInput 的 dwExtraInfo 带它，钩子放行；与 daemon.ps1 里的 MAGIC 一致。 */
export const MAGIC = 1146314819; // 0x44534843 = "DSHC"

/** 紧急解锁后给模型的拒绝话术（工具结果原文）。 */
export const EMERGENCY_REFUSAL =
	"[已停用] 鼠标锁被紧急解除（Ctrl+Alt+L）：操控类工具已停用，截屏仍可用。重启 dsh 后恢复。";

// ── 纯函数（可单测） ─────────────────────────────────────────────────────────

/** 键名 → VK 码。修饰键 + 主键，未知键返回 null。 */
export const KEY_MAP = {
	ctrl: 17, control: 17, alt: 18, shift: 16, win: 91,
	enter: 13, esc: 27, escape: 27, tab: 9, space: 32, backspace: 8, delete: 46,
	up: 38, down: 40, left: 37, right: 39, home: 36, end: 35, pageup: 33, pagedown: 34,
	insert: 45, capslock: 20, pause: 19, printscreen: 44,
	f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117, f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123,
};
for (let c = 0; c < 26; c++) KEY_MAP[String.fromCharCode(97 + c)] = 65 + c;
for (let d = 0; d < 10; d++) KEY_MAP[String(d)] = 48 + d;

/**
 * 解析组合键，如 `ctrl+s` → [17, 83]。顺序 = 修饰键按下顺序 + 主键，
 * daemon 按此顺序按下、逆序抬起。未知键返回 null。
 * @param {string} key
 * @returns {number[] | null}
 */
export function parseKeyCombo(key) {
	if (typeof key !== "string") return null;
	const parts = key.toLowerCase().split("+").map((s) => s.trim()).filter((s) => s.length > 0);
	if (parts.length === 0) return null;
	const vks = [];
	for (const part of parts) {
		const vk = KEY_MAP[part];
		if (vk === undefined) return null;
		vks.push(vk);
	}
	const last = vks.at(-1);
	const MODIFIERS = new Set([17, 18, 16, 91]);
	// 只有修饰键没有主键（如单独 "ctrl"）不合法；主键必须在最后。
	if (MODIFIERS.has(last) && vks.length === 1) return null;
	if (vks.slice(0, -1).some((vk) => !MODIFIERS.has(vk))) return null;
	return vks;
}

/**
 * 钩子事件分类 —— 与 daemon.ps1 里 C# 的条件逐字对应（镜像，供单测钉住语义）。
 * armed 且事件没带注入标记 = 人的真实输入 → 拦截；其余放行。
 * @param {{dwExtraInfo?: number|bigint, armed: boolean, magic?: number}} ev
 * @returns {"allow" | "block"}
 */
export function classifyHookEvent({ dwExtraInfo, armed, magic = MAGIC }) {
	if (!armed) return "allow";
	return BigInt(dwExtraInfo ?? 0) === BigInt(magic) ? "allow" : "block";
}

/** 审批结果是否放行。 */
export function allowsOutcome(outcome) {
	return outcome === "allowed-once";
}

/** 守护进程命令编码（文件 spool 里的单行文本）。 */
export function buildCommand(kind, args = {}) {
	switch (kind) {
		case "arm": return "arm";
		case "disarm": return "disarm";
		case "status": return "status";
		case "quit": return "quit";
		case "pos": return "pos";
		case "move": return `move ${args.x} ${args.y}`;
		case "click": {
			const coords = args.x === undefined ? "" : ` ${args.x} ${args.y}`;
			return `click ${args.button ?? "left"} ${args.count ?? 1}${coords}`;
		}
		case "scroll": return `scroll ${args.lines}`;
		case "type": return `type ${Buffer.from(args.text, "utf8").toString("base64")}`;
		case "keys": return `keys ${args.vks.join(" ")}`;
		case "shot": return `shot ${args.file}`;
		default: throw new Error(`未知命令：${kind}`);
	}
}

/** 解析 daemon 应答：`ok ...` 视为成功（返回余下内容），其余抛错。 */
export function parseReply(text) {
	const s = String(text ?? "").trim();
	if (s.startsWith("ok")) return s.slice(2).trim();
	throw new Error(s.replace(/^err\s*/, "") || "守护进程返回空应答");
}

/** 从 `ok pos 10 20` 取坐标。 */
export function parsePos(reply) {
	const m = /^pos\s+(-?\d+)\s+(-?\d+)$/.exec(reply);
	if (m === null) return null;
	return { x: Number(m[1]), y: Number(m[2]) };
}

// ── daemon.ps1（常驻：钩子 + 注入 + 截图，文件 spool 协议） ─────────────────

const DAEMON_PS = `param([string]$InDir, [string]$OutDir, [int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;

public static class DshGuard {
    public const int MAGIC = 1146314819; // 0x44534843 = "DSHC" —— 与宿主 lib/computer.js 的 MAGIC 一致
    public static volatile bool Armed = false;
    public static volatile bool Emergency = false;
    /** 已拦截的「人」事件计数 —— 自检靠它断言「真的拦了」，不靠光标落点
     *  （这台机器有外部光标活动，位置断言本质不可靠）。 */
    public static volatile int Blocked = 0;
    /** 带 MAGIC 标记、被**放行**的注入事件计数。
     *  靠它断言「AI 没被拦」，它免疫人的活动 —— 用「blocked 不变」来断言会
     *  被偶发的人事件噪声弄假红（曾经就是这么翻的）。 */
    public static volatile int Injected = 0;
    public static string OutDir = "";
    static IntPtr mouseHook = IntPtr.Zero;
    static IntPtr kbdHook = IntPtr.Zero;
    static bool ctrlDown = false;
    static bool altDown = false;

    delegate IntPtr LLProc(int nCode, IntPtr wParam, IntPtr lParam);
    static LLProc mouseCb = OnMouse;
    static LLProc kbdCb = OnKey;

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, LLProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);

    // —— 钩子：armed 时拦人（无标记），放 AI（带 MAGIC）；键盘永不拦，只监听 Ctrl+Alt+L ——
    static IntPtr OnMouse(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && Armed) {
            var m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if (m.dwExtraInfo != (IntPtr)MAGIC) { Blocked++; return (IntPtr)1; }
            Injected++;
        }
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }
    static IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            bool down = wParam == (IntPtr)0x100 || wParam == (IntPtr)0x104;
            bool up = wParam == (IntPtr)0x101 || wParam == (IntPtr)0x105;
            if (k.vkCode == 17 || k.vkCode == 162 || k.vkCode == 163) ctrlDown = down;
            if (k.vkCode == 18 || k.vkCode == 164 || k.vkCode == 165) altDown = down;
            if (down && k.vkCode == 76 && ctrlDown && altDown) {
                Armed = false;
                Emergency = true;
                try { File.WriteAllText(Path.Combine(OutDir, "event-emergency.txt"), DateTime.Now.ToString("o")); } catch { }
            }
        }
        return CallNextHookEx(kbdHook, nCode, wParam, lParam);
    }

    public static void Start() {
        SetProcessDPIAware();
        mouseHook = SetWindowsHookEx(13 + 1, mouseCb, GetModuleHandle(null), 0);
        kbdHook = SetWindowsHookEx(13, kbdCb, GetModuleHandle(null), 0);
        if (mouseHook == IntPtr.Zero) throw new Exception("SetWindowsHookEx(WH_MOUSE_LL) failed: " + Marshal.GetLastWin32Error());
        if (kbdHook == IntPtr.Zero) throw new Exception("SetWindowsHookEx(WH_KEYBOARD_LL) failed: " + Marshal.GetLastWin32Error());
    }
    public static void Stop() {
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        if (kbdHook != IntPtr.Zero) { UnhookWindowsHookEx(kbdHook); kbdHook = IntPtr.Zero; }
    }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSE_MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010,
              MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, MOUSE_WHEEL = 0x0800, MOUSE_ABSOLUTE = 0x8000, MOUSE_VIRTUALDESK = 0x4000;
    const uint KEY_UNICODE = 0x0004;

    static void Send(INPUT[] inputs) {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length) throw new Exception("SendInput 被拒（返回 " + sent + "/" + inputs.Length + "，win32=" + Marshal.GetLastWin32Error() + "；若目标是管理员窗口属 UIPI 预期限制）");
    }
    static INPUT MouseInput(int dx, int dy, uint flags, uint data) {
        var i = new INPUT(); i.type = INPUT_MOUSE;
        i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags, time = 0, dwExtraInfo = (IntPtr)MAGIC };
        return i;
    }
    static INPUT KeyVk(ushort vk, uint flags) {
        var i = new INPUT(); i.type = INPUT_KEYBOARD;
        i.u.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = flags, time = 0, dwExtraInfo = (IntPtr)MAGIC };
        return i;
    }
    static INPUT KeyChar(char c, bool up) {
        // KEYEVENTF_UNICODE 下 wVk 无效、字符放 wScan；与 KeyVk（VK 模式）互斥，不能混。
        var i = new INPUT(); i.type = INPUT_KEYBOARD;
        i.u.ki = new KEYBDINPUT { wVk = 0, wScan = (ushort)c, dwFlags = 0x0004 | (up ? 0x0002u : 0u), time = 0, dwExtraInfo = (IntPtr)MAGIC };
        return i;
    }

    public static void Move(int x, int y) {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
        int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
        Send(new INPUT[] { MouseInput(nx, ny, MOUSE_MOVE | MOUSE_ABSOLUTE | MOUSE_VIRTUALDESK, 0) });
    }
    public static void Click(string button, int count, int x, int y) {
        if (x != int.MinValue) Move(x, y);
        uint down, up;
        if (button == "right") { down = RIGHTDOWN; up = RIGHTUP; }
        else if (button == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
        else { down = LEFTDOWN; up = LEFTUP; }
        for (int i = 0; i < count; i++) {
            if (i > 0) Thread.Sleep(35);
            Send(new INPUT[] { MouseInput(0, 0, down, 0), MouseInput(0, 0, up, 0) });
        }
    }
    public static void Scroll(int lines) {
        Send(new INPUT[] { MouseInput(0, 0, MOUSE_WHEEL, unchecked((uint)(lines * 120))) });
    }
    public static void TypeText(string text) {
        foreach (char c in text) {
            Send(new INPUT[] { KeyChar(c, false), KeyChar(c, true) });
        }
    }
    public static void Keys(ushort[] vks) {
        for (int i = 0; i < vks.Length; i++) Send(new INPUT[] { KeyVk(vks[i], 0) });
        for (int i = vks.Length - 1; i >= 0; i--) Send(new INPUT[] { KeyVk(vks[i], 0x0002) });
    }
    public static string Pos() {
        POINT p; GetCursorPos(out p);
        return p.x + " " + p.y;
    }
    public static void Shot(string file) {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        using (var bmp = new Bitmap(vw, vh))
        using (var g = Graphics.FromImage(bmp)) {
            g.CopyFromScreen(vx, vy, 0, 0, new Size(vw, vh));
            bmp.Save(file, ImageFormat.Png);
        }
    }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing

[DshGuard]::OutDir = $OutDir
[DshGuard]::Start()
[IO.File]::WriteAllText((Join-Path $OutDir "_ready"), [Diagnostics.Process]::GetCurrentProcess().Id.ToString())

function Invoke-Body([string]$body) {
    $tok = $body.Split(' ')
    switch ($tok[0]) {
        'arm'     { if ([DshGuard]::Emergency) { return 'err 紧急解锁已触发（Ctrl+Alt+L），拒绝上锁' } [DshGuard]::Armed = $true; return '' }
        'disarm'  { [DshGuard]::Armed = $false; return '' }
        'status'  { return 'armed ' + $(if ([DshGuard]::Armed) { '1' } else { '0' }) + ' emergency ' + $(if ([DshGuard]::Emergency) { '1' } else { '0' }) + ' blocked ' + [DshGuard]::Blocked + ' injected ' + [DshGuard]::Injected }
        'pos'     { return 'pos ' + [DshGuard]::Pos() }
        'move'    { [DshGuard]::Move([int]$tok[1], [int]$tok[2]); return '' }
        'click'   {
            if ($tok.Length -ge 5) { [DshGuard]::Click($tok[1], [int]$tok[2], [int]$tok[3], [int]$tok[4]) }
            else { [DshGuard]::Click($tok[1], [int]$tok[2], [int.MinValue], 0) }
            return ''
        }
        'scroll'  { [DshGuard]::Scroll([int]$tok[1]); return '' }
        'type'    { [DshGuard]::TypeText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($tok[1]))); return '' }
        'keys'    {
            $vks = @(); for ($i = 1; $i -lt $tok.Length; $i++) { $vks += [uint16][int]$tok[$i] }
            [DshGuard]::Keys([uint16[]]$vks); return ''
        }
        'shot'    { [DshGuard]::Shot(($tok[1..($tok.Length - 1)] -join ' ')); return '' }
        'fakehuman' {
            # 自检专用：模拟一条不带 MAGIC 的真实输入，用来端到端验证「钩子拦人放 AI」。
            #
            # 为什么用**绝对**坐标：mouse_event 的相对位移会受 Windows 指针加速
            # （ballistics）影响，同一个 dy 在连续调用下走出的距离不同 —— 自检就没法
            # 稳定断言方向。绝对坐标不经加速，可精确断言。
            # mouse_event 的 dwExtraInfo 恒为 0（不像 SendInput 能自己设），
            # 所以它就是合格的「人」事件，不会带我们的 MAGIC 标记。
            $x = [int]$tok[1]; $y = [int]$tok[2]
            Add-Type -Namespace DshT -Name M -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);' | Out-Null
            $vw = [DshT.M]::GetSystemMetrics(78); $vh = [DshT.M]::GetSystemMetrics(79)
            $nx = [uint32][Math]::Round($x * 65535.0 / [Math]::Max(1, $vw - 1))
            $ny = [uint32][Math]::Round($y * 65535.0 / [Math]::Max(1, $vh - 1))
            [DshT.M]::mouse_event(0x0001 -bor 0x8000 -bor 0x4000, $nx, $ny, 0, [UIntPtr]::Zero)
            return ''
        }
        default   { throw "未知命令：$($tok[0])" }
    }
}

$script:tick = 0
while ($true) {
    # 父进程死了（崩溃/被杀）→ 自动退出，不留孤儿钩子进程锁着鼠标。
    # 每 8 轮（≈120ms）查一次：宿主被强杀（timeout/SIGKILL，dispose 没机会跑）时，
    # 这段是唯一的兜底 —— 间隔太长会在孤儿窗口里拦着用户的鼠标。
    if ($ParentPid -gt 0 -and $script:tick % 8 -eq 0 -and $script:tick -gt 0) {
        $alive = $true
        try { $null = [Diagnostics.Process]::GetProcessById($ParentPid) } catch { $alive = $false }
        if (-not $alive) { break }
    }
    $script:tick++
    $cmdFile = Get-ChildItem -Path $InDir -Filter '*.cmd' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
    if ($null -ne $cmdFile) {
        $body = [IO.File]::ReadAllText($cmdFile.FullName)
        $outPath = Join-Path $OutDir (($cmdFile.BaseName) + '.out')
        $tmpPath = $outPath + '.tmp'
        try { [IO.File]::WriteAllText($tmpPath, 'ok ' + (Invoke-Body $body)) }
        catch { [IO.File]::WriteAllText($tmpPath, 'err ' + $_.Exception.Message) }
        # 先写 .tmp 再改名：宿主轮询 *.out，非原子写会读到半截 → 空应答/截断坐标。
        Move-Item -LiteralPath $tmpPath -Destination $outPath -Force
        Remove-Item $cmdFile.FullName -Force -ErrorAction SilentlyContinue
        if ($body.Trim() -eq 'quit') { break }
    }
    [System.Windows.Forms.Application]::DoEvents()
    [System.Threading.Thread]::Sleep(15)
}
[DshGuard]::Stop()
`;

// ── daemon 客户端（文件 spool） ──────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 建守护进程客户端。目录里写 daemon.ps1，spawn powershell 跑它，
 * 命令走 in/<seq>.cmd → out/<seq>.out 文件往返；同一时刻只有一条在途命令（mutex）。
 * @param {string} dir spool 目录（宿主创建）
 * @param {{startTimeoutMs: number, runTimeoutMs: number, shotTimeoutMs: number}} config
 */
export function createDaemonClient(dir, config) {
	const inDir = path.join(dir, "in");
	const outDir = path.join(dir, "out");
	const scriptPath = path.join(dir, "daemon.ps1");
	let child = null;
	let ready = false;
	let disposed = false;
	let seq = 0;
	let chain = Promise.resolve();
	let armedAtGen = 0;
	let generation = 0;
	let stderrTail = "";

	const withMutex = (fn) => {
		const run = chain.then(fn);
		chain = run.then(() => undefined, () => undefined);
		return run;
	};

	function spawnDaemon() {
		ready = false;
		fs.rmSync(path.join(outDir, "_ready"), { force: true });
		// 清掉上一任残留的命令：超时路径已向调用方报「未完成」，
		// 重启后补执行就是迟到/重复执行（同一命令真跑两遍，比如双击）。
		for (const stale of fs.readdirSync(inDir)) {
			if (stale.endsWith(".cmd")) fs.rmSync(path.join(inDir, stale), { force: true });
		}
		stderrTail = "";
		const proc = spawn(
			"powershell",
			["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath, inDir, outDir, String(process.pid)],
			{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		child = proc;
		// unref：不让守护进程的句柄挻住宿主事件循环 —— 否则 dsh/自检进程退出不了，
		// 而守护进程靠「父进程死自退」+ dispose 的 quit 兜底，不会变孤儿。
		proc.unref?.();
		proc.stdout?.unref?.();
		proc.stderr?.unref?.();
		proc.stderr?.on("data", (chunk) => {
			stderrTail = (stderrTail + String(chunk)).slice(-1500);
		});
		proc.on("error", (err) => {
			// spawn 失败（EMFILE 等）：只影响自己，不碰后来者的句柄。
			stderrTail = (stderrTail + `\nspawn error: ${err?.message ?? err}`).slice(-1500);
			if (child === proc) { child = null; ready = false; }
		});
		proc.on("exit", (code, sig) => {
			// 关键：kill 旧进程后它的 exit 会迟到 —— 只能清自己的句柄，
			// 否则会把刚 spawn 的新进程句柄误清（启动误报失败）。
			if (child === proc) {
				child = null;
				ready = false;
				if (code !== null && code !== 0) stderrTail = (stderrTail + `\nexit code ${code} signal ${sig ?? "-"}`).slice(-1500);
			}
		});
		generation++;
	}

	async function ensureReady() {
		if (disposed) throw new Error("插件已停用");
		if (child !== null && ready) return;
		if (child !== null && !ready) throw new Error("守护进程正在启动中");
		spawnDaemon();
		const deadline = Date.now() + config.startTimeoutMs;
		while (Date.now() < deadline) {
			if (fs.existsSync(path.join(outDir, "_ready"))) {
				ready = true;
				return;
			}
			if (child === null) break;
			await sleep(50);
		}
		const detail = stderrTail.trim() === "" ? "（无 stderr 输出）" : `：${stderrTail.trim()}`;
		try { child?.kill(); } catch { /* ignore */ }
		child = null;
		throw new Error(`守护进程启动失败${detail}`);
	}

	/** 杀掉守护进程（下次 ensureReady 重启）；用于超时中毒与 dispose。 */
	function killDaemon() {
		const pid = child?.pid;
		child = null;
		ready = false;
		if (pid === undefined) return;
		try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* ignore */ }
	}

	async function send(cmd, timeoutMs) {
		return withMutex(async () => {
			await ensureReady();
			seq += 1;
			const name = `${String(seq).padStart(8, "0")}.cmd`;
			const outName = `${String(seq).padStart(8, "0")}.out`;
			fs.writeFileSync(path.join(inDir, name), cmd, "utf8");
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const outPath = path.join(outDir, outName);
				if (fs.existsSync(outPath)) {
					let text = "";
					try { text = fs.readFileSync(outPath, "utf8"); } catch { /* ignore */ }
					fs.rmSync(outPath, { force: true });
					return parseReply(text);
				}
				if (child === null) break;
				await sleep(20);
			}
			killDaemon();
			throw new Error("守护进程无响应，已重启（本条命令未完成）");
		});
	}

	return {
		scriptPath,
		inDir,
		outDir,
		dir,
		get generation() { return generation; },
		get armedAtGen() { return armedAtGen; },
		set armedAtGen(v) { armedAtGen = v; },
		start: () => withMutex(() => ensureReady()),
		send,
		isAlive: () => child !== null && ready,
		kill: killDaemon,
		dispose() {
			disposed = true;
			// 优雅退出：写 quit 命令，等它回；等不到就 taskkill 兜底。
			try {
				if (child !== null && ready) {
					seq += 1;
					fs.writeFileSync(path.join(inDir, `${String(seq).padStart(8, "0")}.cmd`), "quit", "utf8");
				}
			} catch { /* ignore */ }
			const pid = child?.pid;
			const killer = setTimeout(() => {
				if (pid !== undefined) {
					try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* ignore */ }
				}
			}, 1200);
			killer.unref?.();
			child = null;
			ready = false;
		},
	};
}

// ── 安装 ────────────────────────────────────────────────────────────────────

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{config: Record<string, any>}} options
 * @returns {{enabled: boolean, reason?: string, describe: () => string, dispose: () => void}}
 */
export function installComputer(ctx, { config }) {
	const disabled = (reason) => ({
		enabled: false,
		reason,
		describe: () => `操控电脑：关（${reason}）`,
		dispose: () => {},
	});

	if (config.enabled !== true) return disabled("配置里关掉了");
	if (process.platform !== "win32") return disabled("仅 Windows");

	const log = {
		warn: (...a) => { try { ctx.logger?.warn?.(...a); } catch { /* ignore */ } },
	};

	// —— spool 目录 + daemon 脚本（每次安装唯一，多实例/多插件不撞） ——
	const dir = path.join(os.tmpdir(), `dsh-team-computer-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
	fs.mkdirSync(path.join(dir, "in"), { recursive: true });
	fs.mkdirSync(path.join(dir, "out"), { recursive: true });
	const scriptPath = path.join(dir, "daemon.ps1");
	// 必须带 UTF-8 BOM：Windows PowerShell 5.1 用 -File 读无 BOM 文件按系统 ANSI（GBK）解码，
	// 中文注释字节会解出乱码造成假解析错误（实测：ParseInput 同内容零错、ParseFile 报错）。
	fs.writeFileSync(scriptPath, `\uFEFF${DAEMON_PS}`, "utf8");

	const daemon = createDaemonClient(dir, config);

	// —— 审批 + 会话级放行 ——
	const confirmed = new Set();
	async function approve(exec, toolName, reason) {
		const session = exec?.agent?.session;
		if (session !== undefined && confirmed.has(session)) return true;
		const approval = ctx.get?.("approval");
		if (approval === undefined || approval === null || typeof approval.request !== "function") return false;
		if (exec?.agent === undefined) return false;
		let outcome;
		try {
			// 会话级授权：批准后本会话所有操控工具放行（产品语义，REQ-002 §1）——
			// 但必须在弹窗里把「连带放行」告知，否则批准一次只读截屏 = 静默放行点击打字（第 3 层 P1）。
			outcome = await approval.request({
				agent: exec.agent,
				toolName,
				reason: `${reason}。【会话级授权】批准后本会话的截屏与所有鼠标/键盘操作均放行，不再逐次询问。`,
				signal: exec.signal,
			});
		} catch {
			return false;
		}
		if (!allowsOutcome(outcome)) return false;
		if (session !== undefined) confirmed.add(session);
		return true;
	}

	// —— 鼠标锁生命周期 ——
	let armed = false;
	let emergency = false;
	let idleTimer = null;

	function touchIdle() {
		if (idleTimer !== null) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			armed = false;
			daemon.send(buildCommand("disarm"), config.runTimeoutMs).catch(() => { /* 进程死了本来就解锁 */ });
		}, config.idleUnlockMs);
		idleTimer.unref?.();
	}

	/** 操控动作前调用：确保钩子 armed，并刷新空闲计时。失败抛错（操作不执行）。 */
	async function ensureArmed() {
		if (emergency) throw new Error("鼠标锁已被紧急解除（Ctrl+Alt+L），操控已停用");
		// 每次实操前查一次 status（权威）：紧急解锁的探测靠这里，不靠 fs.watch ——
		// Windows 上 fs.watch 的句柄 **unref 无效**，会把宿主/任何 apply 过的进程
		// 死在事件循环里退不出去（实测 npm test 链被它卡到超时）。
		// 代价：每次操控多一次 spool 往返（~20ms），对比人工审批弹窗可忽略。
		const st = await daemon.send(buildCommand("status"), config.runTimeoutMs).catch(() => "");
		if (st.includes("emergency 1")) {
			emergency = true;
			if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
			log.warn("computer: 鼠标锁被紧急解除（Ctrl+Alt+L），操控类工具已停用，重启 dsh 恢复");
			throw new Error("鼠标锁已被紧急解除（Ctrl+Alt+L），操控已停用");
		}
		if (armed && daemon.isAlive() && daemon.armedAtGen === daemon.generation) {
			touchIdle();
			return;
		}
		await daemon.send(buildCommand("arm"), config.runTimeoutMs);
		armed = true;
		daemon.armedAtGen = daemon.generation;
		touchIdle();
	}

	// 紧急解锁探测：靠 ensureArmed 的 status 查询（见上），不用 fs.watch（会拴事件循环）。
	// daemon 仍会写 out/event-emergency.txt 作为证据文件，便于排障。

	// —— 输出形状 ——
	const textOut = () => ({
		schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
		render: (_args, value) => [{ type: "text", text: value.text }],
	});
	const shotOut = () => ({
		schema: {
			// 标准 JSON Schema：required 必须是数组，property 内不能有 `required: true`
			// —— `ctx.tools.register()` 的 assertSupportedJsonSchema 只认这一种
			// （照 dsh-tool-fs 内部方言写会直接拒载，实测 1.6.0 启动失败）。
			type: "object",
			additionalProperties: false,
			required: ["image", "caption"],
			properties: {
				image: {
					type: "object",
					additionalProperties: false,
					required: ["attachmentId", "mediaType", "bytes", "width", "height"],
					properties: {
						attachmentId: { type: "string" },
						mediaType: { type: "string" },
						bytes: { type: "integer" },
						width: { type: "integer" },
						height: { type: "integer" },
						name: { type: "string" },
					},
				},
				caption: { type: "string" },
			},
		},
		render: (_args, value) => [
			{ type: "text", text: value.caption },
			{ type: "image", attachment: value.image },
		],
	});

	const deny = (why) => ({ text: `[审批被拒] ${why}` });

	// —— 路由门禁（模型必须支持 image 输入，照 dsh-tool-fs assertImageCapableRoute）——
	async function assertImageRoute(exec, what) {
		const routed = exec?.agent?.session?.requestHeader?.()?.config;
		const provider = routed?.provider ?? exec?.agent?.options?.provider;
		const model = routed?.model ?? exec?.agent?.options?.model;
		const llm = ctx.get?.("llm");
		if (provider === undefined || model === undefined || llm === undefined || llm === null) {
			throw new Error(`无法确认当前模型是否支持看图：${what}被拒绝（路由不可解析）`);
		}
		const active = await llm.resolveModelInfo(provider, model, exec.signal);
		const modalities = active.inputModalities ?? active.context?.inputModalities;
		if (!Array.isArray(modalities) || !modalities.includes("image")) {
			throw new Error(`当前模型 "${model}" 不支持图像输入，无法${what}；换到支持 image 的模型`);
		}
	}

	const disposers = [];
	const register = (definition) => {
		disposers.push(ctx.tools.register(definition));
	};

	const stopped = () => ({ text: EMERGENCY_REFUSAL });

	register({
		name: "screenshot",
		description:
			"截取整个屏幕（含多显示器拼接的虚拟屏）并把 PNG 作为图片返回给你自己看 —— 用它查看当前屏幕状态，再决定下一步操作。" +
			"首次调用（本会话）需要用户审批。不锁定鼠标（只读）。",
		parameters: toParameterSchema({}),
		output: shotOut(),
		isConcurrencySafe: () => false,
		async execute(_args, exec) {
			if (!(await approve(exec, "screenshot", "截取整屏图像（AI 将看到屏幕上的一切）"))) {
				return deny("用户未批准截屏");
			}
			try {
				await assertImageRoute(exec, "截屏");
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
			const attachments = ctx.get?.("attachments");
			if (attachments === undefined || attachments === null || typeof attachments.saveImage !== "function") {
				return { text: "[失败] 无附件服务，图片无处存放（dsh attachments 未挂载）" };
			}
			const file = path.join(daemon.dir, `shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
			try {
				await daemon.send(buildCommand("shot", { file }), config.shotTimeoutMs);
				const data = fs.readFileSync(file);
				if (data.length < 8 || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) {
					return { text: "[失败] 守护进程产出的不是 PNG（文件头不对）" };
				}
				const ref = await attachments.saveImage({ data, mediaType: "image/png", name: "screenshot.png" });
				return {
					image: {
						attachmentId: ref.attachmentId,
						mediaType: ref.mediaType,
						bytes: ref.bytes,
						width: ref.width,
						height: ref.height,
						...ref.name === undefined ? {} : { name: ref.name },
					},
					caption: `整屏截图 ${ref.width}x${ref.height} px（虚拟屏，可能含多个显示器）`,
				};
			} catch (err) {
				return { text: `[失败] 截图失败：${err?.message ?? err}` };
			} finally {
				fs.rmSync(file, { force: true });
			}
		},
	});

	register({
		name: "cursor_position",
		description: "读取当前鼠标光标坐标（像素，屏幕左上角为原点）。",
		parameters: toParameterSchema({}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(_args, exec) {
			if (!(await approve(exec, "cursor_position", "读取鼠标坐标（只读）"))) return deny("用户未批准");
			try {
				const reply = await daemon.send(buildCommand("pos"), config.runTimeoutMs);
				const pos = parsePos(reply);
				if (pos === null) return { text: `[失败] 坐标解析失败：${reply}` };
				return { text: `(${pos.x}, ${pos.y})` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "mouse_move",
		description:
			"把鼠标移动到屏幕坐标 (x, y)（像素，左上角原点；多屏用虚拟屏坐标，可为负）。" +
			"执行期间真实鼠标输入被钩子锁定（防止人误碰），AI 的移动不受影响。首次操作需用户审批；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 15s 自动解锁。",
		parameters: toParameterSchema({
			x: { type: "integer", required: true, description: "目标 X 像素坐标。" },
			y: { type: "integer", required: true, description: "目标 Y 像素坐标。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (emergency) return stopped();
			const x = Number(args?.x);
			const y = Number(args?.y);
			if (!Number.isFinite(x) || !Number.isFinite(y)) return { text: "[参数错误] x/y 必须是整数坐标。" };
			if (!(await approve(exec, "mouse_move", `移动鼠标到 (${Math.round(x)}, ${Math.round(y)})`))) {
				return deny("用户未批准鼠标操作");
			}
			try {
				await ensureArmed();
				await daemon.send(buildCommand("move", { x: Math.round(x), y: Math.round(y) }), config.runTimeoutMs);
				return { text: `已移动到 (${Math.round(x)}, ${Math.round(y)})。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "mouse_click",
		description:
			"在屏幕坐标点击（给了 x/y 先移动再点；不给就点在当前位置）。button: left/right/middle；count: 1 或 2（双击）。" +
			"执行期间真实鼠标输入被锁定；首次操作需用户审批；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 15s 自动解锁。",
		parameters: toParameterSchema({
			x: { type: "integer", description: "点击位置 X（省略则点当前位置）。" },
			y: { type: "integer", description: "点击位置 Y（省略则点当前位置）。" },
			button: { type: "string", enum: ["left", "right", "middle"], description: "按键，默认 left。" },
			count: { type: "integer", description: "点几下（2 = 双击），默认 1。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (emergency) return stopped();
			const hasPos = args?.x !== undefined && args?.y !== undefined;
			const x = hasPos ? Math.round(Number(args.x)) : undefined;
			const y = hasPos ? Math.round(Number(args.y)) : undefined;
			if (hasPos && (!Number.isFinite(x) || !Number.isFinite(y))) return { text: "[参数错误] x/y 必须是整数坐标。" };
			const button = ["left", "right", "middle"].includes(args?.button) ? args.button : "left";
			const count = Number(args?.count) >= 2 ? 2 : 1;
			const where = hasPos ? `(${x}, ${y})` : "当前位置";
			if (!(await approve(exec, "mouse_click", `${count === 2 ? "双击" : button + "击"}${where}（真实点击）`))) {
				return deny("用户未批准鼠标操作");
			}
			try {
				await ensureArmed();
				await daemon.send(buildCommand("click", { button, count, ...(hasPos ? { x, y } : {}) }), config.runTimeoutMs);
				return { text: `已在 ${where} ${count === 2 ? "双击" : `${button} 单击`}。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "scroll",
		description: "在**当前鼠标位置**滚动滚轮（先 mouse_move 到目标再 scroll）。lines 正数向上、负数向下，每格约 3 行。执行期间真实鼠标输入被锁定；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 15s 自动解锁。",
		parameters: toParameterSchema({
			lines: { type: "integer", required: true, description: "滚动格数，正上负下（如 3 / -3）。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (emergency) return stopped();
			const lines = Math.trunc(Number(args?.lines));
			if (!Number.isFinite(lines) || lines === 0) return { text: "[参数错误] lines 必须是非 0 整数。" };
			if (!(await approve(exec, "scroll", `滚动 ${lines > 0 ? "向上" : "向下"} ${Math.abs(lines)} 格`))) {
				return deny("用户未批准鼠标操作");
			}
			try {
				await ensureArmed();
				await daemon.send(buildCommand("scroll", { lines }), config.runTimeoutMs);
				return { text: `已滚动 ${lines}。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "type_text",
		description:
			"在**当前焦点的输入框**里逐字符打字（支持中文；按真实键盘事件注入，不是粘贴）。" +
			"打字前先用 screenshot + mouse_click 让目标输入框获得焦点。执行期间真实鼠标输入被锁定；首次操作需用户审批；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 15s 自动解锁。",
		parameters: toParameterSchema({
			text: { type: "string", required: true, description: "要输入的文本。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (emergency) return stopped();
			const text = String(args?.text ?? "");
			if (text.length === 0) return { text: "[参数错误] text 不能为空。" };
			if (text.length > 4000) return { text: "[参数错误] 单次最多 4000 字符，分批输入。" };
			if (!(await approve(exec, "type_text", `向当前焦点窗口键入 ${text.length} 字符（真实键盘输入）`))) {
				return deny("用户未批准键盘操作");
			}
			try {
				await ensureArmed();
				await daemon.send(buildCommand("type", { text }), config.runTimeoutMs);
				return { text: `已输入 ${text.length} 字符。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "key_press",
		description:
			"按一个键或组合键，如 `ctrl+s`、`shift+tab`、`enter`、`esc`、`f5`。" +
			"支持：ctrl/alt/shift/win + 字母数字 + enter/esc/tab/space/backspace/delete/方向键/f1-f12。执行期间真实鼠标输入被锁定；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 15s 自动解锁。",
		parameters: toParameterSchema({
			key: { type: "string", required: true, description: "键或组合键，如 `ctrl+s`。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (emergency) return stopped();
			const key = String(args?.key ?? "");
			const vks = parseKeyCombo(key);
			if (vks === null) {
				return { text: `[参数错误] 无法识别按键 "${key}"（示例：ctrl+s、shift+tab、enter）。` };
			}
			if (!(await approve(exec, "key_press", `按下按键 ${key}（真实键盘输入）`))) {
				return deny("用户未批准键盘操作");
			}
			try {
				await ensureArmed();
				await daemon.send(buildCommand("keys", { vks }), config.runTimeoutMs);
				return { text: `已按下 ${key}。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	// 不预热：安装时 spawn 常驻进程是副作用（污染任何 apply 进程的事件循环，
	// 也让「默认启用」变成「默认多一个进程」）。首次实操时才冷启动（daemon.send 自带 ensureReady）。
	// 代价：首次操控多 ~1s 冷启动；收益：不碰电脑就完全零进程、零开销。

	return {
		enabled: true,
		describe: () => `操控电脑：开（锁鼠标空闲 ${Math.round(config.idleUnlockMs / 1000)}s 解锁；紧急解锁 Ctrl+Alt+L）`,
		/** 内部句柄（自检与排障用）：守护进程 spool 客户端。 */
		daemon,
		dispose() {
			if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
			for (const d of disposers.splice(0)) {
				try { d?.(); } catch { /* ignore */ }
			}
			daemon.dispose();
			setTimeout(() => {
				try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
			}, 1500).unref?.();
		},
	};
}
