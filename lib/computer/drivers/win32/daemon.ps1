param([string]$InDir, [string]$OutDir, [int]$ParentPid = 0)
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
    /** 未上锁时**通过**的「人」事件计数。
     *  用途：断言「disarm 后不再拦人」。这台机器实测有 ~34 个合成鼠标事件/秒
     *  （不动光标，只发输入），所以不能用「blocked 不变」—— 只能用「passedHuman 上升」。
     *  若代码忽略 Armed 而始终拦截，这个计数就永远不会涨，断言会正确地红。 */
    public static volatile int PassedHuman = 0;
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
        if (nCode >= 0) {
            var m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            bool injected = m.dwExtraInfo == (IntPtr)MAGIC;
            if (Armed) {
                if (!injected) { Blocked++; return (IntPtr)1; }
                Injected++;
            } else if (!injected) {
                PassedHuman++;
            }
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

    static Thread hookThread = null;
    static uint hookThreadId = 0;
    static volatile bool HookReady = false;
    static volatile string HookError = null;

    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; public uint lPrivate; }

    /// 在**独立线程**上装钩子并跑紧消息循环。
    ///
    /// 为什么必须独立线程（真实 bug）：LL 钩子的回调由系统投递到**装钩子的那个线程**，
    /// 并要求它及时处理。如果与「文件轮询 + Sleep(15)」共用主线程，真实鼠标（100+ 事件/秒）
    /// 的回调会排队、被系统判超时后**放行** —— 表现就是「鼠标卡一下、但还能动」。
    /// 实测：守护进程自己注入时（主线程正忙）能拦；外部进程注入时也勉强能拦，
    /// 但真实鼠标持续输入下就会漏。
    public static void StartHooks() {
        hookThread = new Thread(HookLoop);
        hookThread.IsBackground = true;
        hookThread.SetApartmentState(ApartmentState.STA);
        hookThread.Start();
        for (int i = 0; i < 300 && !HookReady; i++) Thread.Sleep(10);
        if (!HookReady) throw new Exception("钩子线程启动超时");
        if (HookError != null) throw new Exception(HookError);
    }

    static void HookLoop() {
        // 最高优先级：钩子回调晚一点都可能让系统判超时。
        Thread.CurrentThread.Priority = ThreadPriority.Highest;
        hookThreadId = GetCurrentThreadId();
        SetProcessDPIAware();
        mouseHook = SetWindowsHookEx(14, mouseCb, GetModuleHandle(null), 0);
        kbdHook = SetWindowsHookEx(13, kbdCb, GetModuleHandle(null), 0);
        if (mouseHook == IntPtr.Zero) HookError = "SetWindowsHookEx(WH_MOUSE_LL) failed: " + Marshal.GetLastWin32Error();
        else if (kbdHook == IntPtr.Zero) HookError = "SetWindowsHookEx(WH_KEYBOARD_LL) failed: " + Marshal.GetLastWin32Error();
        HookReady = true;
        MSG msg;
        // 紧循环：只泵消息，不做任何文件 I/O —— 这是「锁得住」的关键。
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        if (kbdHook != IntPtr.Zero) { UnhookWindowsHookEx(kbdHook); kbdHook = IntPtr.Zero; }
    }

    /// 让钩子线程退出（卸钩子在它自己的循环末尾做）。
    public static void StopHooks() {
        if (hookThreadId != 0) PostThreadMessage(hookThreadId, 0x0012, IntPtr.Zero, IntPtr.Zero); // WM_QUIT
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
# 钩子跑在守护进程自己的独立线程上（紧消息循环）；下面的主循环只管文件轮询。
# 两者分开是「锁得住」的前提，详见 StartHooks 的注释。
[DshGuard]::StartHooks()
[IO.File]::WriteAllText((Join-Path $OutDir "_ready"), [Diagnostics.Process]::GetCurrentProcess().Id.ToString())

function Invoke-Body([string]$body) {
    $tok = $body.Split(' ')
    switch ($tok[0]) {
        'arm'     { if ([DshGuard]::Emergency) { return 'err 紧急解锁已触发（Ctrl+Alt+L），拒绝上锁' } [DshGuard]::Armed = $true; return '' }
        'disarm'  { [DshGuard]::Armed = $false; return '' }
        'status'  { return 'armed ' + $(if ([DshGuard]::Armed) { '1' } else { '0' }) + ' emergency ' + $(if ([DshGuard]::Emergency) { '1' } else { '0' }) + ' blocked ' + [DshGuard]::Blocked + ' injected ' + [DshGuard]::Injected + ' passed ' + [DshGuard]::PassedHuman }
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
    # 不再调 DoEvents：钩子有自己的线程在泵消息，主线程只管 I/O。
    [System.Threading.Thread]::Sleep(15)
}
[DshGuard]::StopHooks()
