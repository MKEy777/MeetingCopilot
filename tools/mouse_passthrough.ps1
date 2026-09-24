# Windows only. Reports physical mouse input without consuming it; the real
# messages continue to the window beneath MeetingCopilot's click-through UI.
$source = @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class MeetingCopilotMouseHook {
    private const int WH_MOUSE_LL = 14;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_MOUSEWHEEL = 0x020A;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseData {
        public Point Pt;
        public uint MouseExtra;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message {
        public IntPtr HWnd;
        public uint Msg;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Pt;
        public uint Private;
    }

    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    private static readonly HookProc CallbackRef = OnMouse;
    private static IntPtr hook;
    private static long lastMoveTick;
    private static readonly ConcurrentQueue<string> pending = new ConcurrentQueue<string>();
    private static readonly AutoResetEvent pendingSignal = new AutoResetEvent(false);
    private static int pendingCount;
    private static volatile bool running = true;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr handle);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr handle, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string name);

    private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0) {
            int message = wParam.ToInt32();
            string type = null;
            if (message == WM_MOUSEMOVE) {
                long now = Environment.TickCount;
                if (now - lastMoveTick >= 16 || now < lastMoveTick) {
                    lastMoveTick = now;
                    type = "move";
                }
            } else if (message == WM_LBUTTONDOWN) type = "down";
            else if (message == WM_LBUTTONUP) type = "up";
            else if (message == WM_MOUSEWHEEL) type = "wheel";

            if (type != null) {
                MouseData data = (MouseData)Marshal.PtrToStructure(lParam, typeof(MouseData));
                // The hook must return promptly. Writing to a pipe here can block
                // long enough for Windows to silently remove the hook.
                if (type == "move" && Volatile.Read(ref pendingCount) > 256)
                    return CallNextHookEx(hook, code, wParam, lParam);
                string line;
                if (type == "wheel") {
                    short delta = unchecked((short)(data.MouseExtra >> 16));
                    line = string.Format("wheel\t{0}\t{1}\t{2}", data.Pt.X, data.Pt.Y, delta);
                } else {
                    line = string.Format("{0}\t{1}\t{2}", type, data.Pt.X, data.Pt.Y);
                }
                pending.Enqueue(line);
                Interlocked.Increment(ref pendingCount);
                pendingSignal.Set();
            }
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    private static void WritePending() {
        while (running) {
            pendingSignal.WaitOne(100);
            string line;
            while (pending.TryDequeue(out line)) {
                Interlocked.Decrement(ref pendingCount);
                Console.WriteLine(line);
            }
            Console.Out.Flush();
        }
    }

    public static void Run() {
        Thread writer = new Thread(WritePending);
        writer.IsBackground = true;
        writer.Start();
        hook = SetWindowsHookEx(WH_MOUSE_LL, CallbackRef, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        Console.WriteLine("READY");
        Console.Out.Flush();
        try {
            Message message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        } finally {
            UnhookWindowsHookEx(hook);
            running = false;
            pendingSignal.Set();
        }
    }
}
'@

Add-Type -TypeDefinition $source -ErrorAction Stop
[MeetingCopilotMouseHook]::Run()
