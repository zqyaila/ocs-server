/*
 * OCS 网课助手 · Windows 托盘启动器
 *
 * 双击后不弹任何窗口：
 *   1. 在通知区域（任务栏右下角）放一个图标；
 *   2. 用自带的 node.exe 在后台跑 app\launch.js，输出写到 app\data\ocs.log；
 *   3. 服务起来后 launch.js 自己打开浏览器。
 *
 * 托盘菜单：打开控制台 / 查看运行日志 / 重新启动服务 / 退出。
 *
 * 两个关键点：
 *   - Job Object 绑定 node：启动器一退出（包括被任务管理器强杀），node 一定跟着死，
 *     不会留个僵尸进程占着端口，下次启动又以为「已经有一份在跑」。
 *   - 单实例互斥：重复双击只会把浏览器再打开一次，不会起第二个服务。
 */
#define UNICODE
#define _UNICODE
#define WINVER 0x0601
#define _WIN32_WINNT 0x0601

#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>

#define WM_TRAYMSG   (WM_APP + 1)
#define IDM_OPEN     1001
#define IDM_LOG      1002
#define IDM_RESTART  1003
#define IDM_EXIT     1004
#define TRAY_UID     1
#define TRAY_ICON    1

static HWND             g_hwnd;
static HANDLE           g_job;
static HANDLE           g_proc;
static BOOL             g_exiting;
static BOOL             g_running;
static wchar_t          g_dir[MAX_PATH];
static wchar_t          g_data[MAX_PATH];
static wchar_t          g_log[MAX_PATH];
static UINT             g_taskbarMsg;
static NOTIFYICONDATAW  g_nid;

static void fatal(const wchar_t *msg) {
    MessageBoxW(NULL, msg, L"OCS 网课助手", MB_OK | MB_ICONERROR);
}

/* ---------------- 托盘图标 ---------------- */

static void trayTip(const wchar_t *tip) {
    lstrcpynW(g_nid.szTip, tip, ARRAYSIZE(g_nid.szTip));
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

static void trayAdd(void) {
    g_nid.cbSize = sizeof(g_nid);
    g_nid.hWnd = g_hwnd;
    g_nid.uID = TRAY_UID;
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_nid.uCallbackMessage = WM_TRAYMSG;
    g_nid.hIcon = LoadIconW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(TRAY_ICON));
    if (!g_nid.hIcon) g_nid.hIcon = LoadIconW(NULL, IDI_APPLICATION);
    lstrcpynW(g_nid.szTip, L"OCS 网课助手 · 正在运行", ARRAYSIZE(g_nid.szTip));
    Shell_NotifyIconW(NIM_ADD, &g_nid);
}

static void trayRemove(void) {
    Shell_NotifyIconW(NIM_DELETE, &g_nid);
}

/* 气泡提示：Win10/11 可能被「专注助手 / 通知设置」拦掉，所以只当锦上添花 */
static void balloon(const wchar_t *text, DWORD icon) {
    NOTIFYICONDATAW n;
    ZeroMemory(&n, sizeof(n));
    n.cbSize = sizeof(n);
    n.hWnd = g_hwnd;
    n.uID = TRAY_UID;
    n.uFlags = NIF_INFO;
    lstrcpynW(n.szInfoTitle, L"OCS 网课助手", ARRAYSIZE(n.szInfoTitle));
    lstrcpynW(n.szInfo, text, ARRAYSIZE(n.szInfo));
    n.dwInfoFlags = icon;
    Shell_NotifyIconW(NIM_MODIFY, &n);
}

/* ---------------- 打开控制台 / 日志 ---------------- */

/* 实际端口可能是顺延过的（8899 被占用），launch.js 会把真正在用的端口写进 data\.port */
static void openConsole(void) {
    wchar_t portFile[MAX_PATH];
    wchar_t url[128];
    int port = 8899;

    _snwprintf(portFile, MAX_PATH, L"%s\\.port", g_data);
    FILE *f = _wfopen(portFile, L"rb");
    if (f) {
        char buf[32];
        ZeroMemory(buf, sizeof(buf));
        if (fread(buf, 1, sizeof(buf) - 1, f) > 0) {
            int v = atoi(buf);
            if (v > 0 && v < 65536) port = v;
        }
        fclose(f);
    }

    _snwprintf(url, 128, L"http://127.0.0.1:%d/", port);
    ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
}

static void openLog(void) {
    if (GetFileAttributesW(g_log) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(NULL, L"还没有日志。服务启动之后才会写。", L"OCS 网课助手", MB_OK | MB_ICONINFORMATION);
        return;
    }
    ShellExecuteW(NULL, L"open", L"notepad.exe", g_log, NULL, SW_SHOWNORMAL);
}

/* 日志超过 8MB 就滚一份，免得越积越大 */
static void rotateLog(void) {
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExW(g_log, GetFileExInfoStandard, &fad)) return;

    ULARGE_INTEGER sz;
    sz.HighPart = fad.nFileSizeHigh;
    sz.LowPart = fad.nFileSizeLow;
    if (sz.QuadPart <= 8ull * 1024 * 1024) return;

    wchar_t old[MAX_PATH];
    _snwprintf(old, MAX_PATH, L"%s\\ocs.old.log", g_data);
    DeleteFileW(old);
    MoveFileW(g_log, old);
}

/* ---------------- 启动 node ---------------- */

static void ensureJob(void) {
    if (g_job) return;
    g_job = CreateJobObjectW(NULL, NULL);
    if (!g_job) return;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
    ZeroMemory(&jeli, sizeof(jeli));
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
}

static BOOL startNode(void) {
    wchar_t node[MAX_PATH];
    wchar_t script[MAX_PATH];
    wchar_t cmd[MAX_PATH * 4];

    _snwprintf(node, MAX_PATH, L"%s\\node.exe", g_dir);
    _snwprintf(script, MAX_PATH, L"%s\\app\\launch.js", g_dir);
    if (GetFileAttributesW(node) == INVALID_FILE_ATTRIBUTES) {
        fatal(L"找不到 node.exe。\n\n安装不完整，请重新运行安装程序。");
        return FALSE;
    }
    if (GetFileAttributesW(script) == INVALID_FILE_ATTRIBUTES) {
        fatal(L"找不到 app\\launch.js。\n\n安装不完整，请重新运行安装程序。");
        return FALSE;
    }

    rotateLog();

    SECURITY_ATTRIBUTES sa;
    ZeroMemory(&sa, sizeof(sa));
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE hLog = CreateFileW(g_log, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hLog != INVALID_HANDLE_VALUE) {
        LARGE_INTEGER size;
        if (GetFileSizeEx(hLog, &size) && size.QuadPart == 0) {
            DWORD wrote = 0;
            /* 写个 UTF-8 BOM：记事本据此识别编码，中文日志才不会乱码 */
            WriteFile(hLog, "\xEF\xBB\xBF", 3, &wrote, NULL);
        }
    }

    HANDLE hNul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                              OPEN_EXISTING, 0, NULL);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    /* node 没有控制台，输出全部落到日志文件 */
    if (hLog != INVALID_HANDLE_VALUE) {
        si.dwFlags |= STARTF_USESTDHANDLES;
        si.hStdOutput = hLog;
        si.hStdError = hLog;
        si.hStdInput = (hNul != INVALID_HANDLE_VALUE) ? hNul : INVALID_HANDLE_VALUE;
    }

    _snwprintf(cmd, MAX_PATH * 4, L"\"%s\" \"%s\"", node, script);
    ZeroMemory(&pi, sizeof(pi));

    BOOL ok = CreateProcessW(node, cmd, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, g_dir, &si, &pi);
    DWORD err = ok ? 0 : GetLastError();

    if (hLog != INVALID_HANDLE_VALUE) CloseHandle(hLog);
    if (hNul != INVALID_HANDLE_VALUE) CloseHandle(hNul);

    if (!ok) {
        wchar_t buf[256];
        _snwprintf(buf, 256, L"启动 node.exe 失败（错误码 %lu）。", err);
        fatal(buf);
        return FALSE;
    }

    ensureJob();
    if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);

    CloseHandle(pi.hThread);
    g_proc = pi.hProcess;
    g_running = TRUE;
    trayTip(L"OCS 网课助手 · 正在运行");
    return TRUE;
}

static void stopNode(void) {
    if (g_job) {
        /* KILL_ON_JOB_CLOSE：关掉 job 句柄，node 及其子进程一起走 */
        CloseHandle(g_job);
        g_job = NULL;
    }
    if (g_proc) {
        CloseHandle(g_proc);
        g_proc = NULL;
    }
    g_running = FALSE;
}

static void onNodeExit(void) {
    DWORD code = 0;
    if (g_proc) {
        GetExitCodeProcess(g_proc, &code);
        CloseHandle(g_proc);
        g_proc = NULL;
    }
    g_running = FALSE;
    if (g_exiting) return;

    /* 退出码 0：launch.js 认为端口上已经有一份在跑，自己收尾了，托盘也没必要留着 */
    if (code == 0) {
        g_exiting = TRUE;
        PostQuitMessage(0);
        return;
    }

    trayTip(L"OCS 网课助手 · 服务已停止");
    balloon(L"服务意外退出，右键托盘图标可以重新启动，或查看运行日志。", NIIF_WARNING);
}

/* ---------------- 右键菜单 ---------------- */

static void showMenu(void) {
    HMENU m = CreatePopupMenu();
    if (!m) return;

    AppendMenuW(m, MF_STRING, IDM_OPEN, L"打开控制台");
    AppendMenuW(m, MF_SEPARATOR, 0, NULL);
    AppendMenuW(m, MF_STRING, IDM_LOG, L"查看运行日志");
    if (!g_running) AppendMenuW(m, MF_STRING, IDM_RESTART, L"重新启动服务");
    AppendMenuW(m, MF_SEPARATOR, 0, NULL);
    AppendMenuW(m, MF_STRING, IDM_EXIT, L"退出");

    POINT pt;
    GetCursorPos(&pt);
    /* 不先抢焦点的话，菜单点到别处不会消失 */
    SetForegroundWindow(g_hwnd);
    TrackPopupMenu(m, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, 0, g_hwnd, NULL);
    PostMessageW(g_hwnd, WM_NULL, 0, 0);
    DestroyMenu(m);
}

/* 右键菜单点开之前，左键单击/双击都当「打开控制台」 */
static void onTrayEvent(WPARAM wParam, LPARAM lParam) {
    UINT ev = LOWORD(lParam);
    if (ev == WM_LBUTTONUP || ev == WM_LBUTTONDBLCLK) {
        openConsole();
        return;
    }
    if (ev == WM_RBUTTONUP || ev == WM_CONTEXTMENU) {
        showMenu();
    }
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    /* explorer.exe 重启后托盘图标会被清空，收到广播就补一个 */
    if (g_taskbarMsg && msg == g_taskbarMsg) {
        trayAdd();
        return 0;
    }
    switch (msg) {
    case WM_TRAYMSG:
        onTrayEvent(wParam, lParam);
        return 0;
    case WM_COMMAND:
        switch (LOWORD(wParam)) {
        case IDM_OPEN:
            openConsole();
            return 0;
        case IDM_LOG:
            openLog();
            return 0;
        case IDM_RESTART:
            stopNode();
            startNode();
            return 0;
        case IDM_EXIT:
            g_exiting = TRUE;
            DestroyWindow(hwnd);
            return 0;
        }
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

/* ---------------- 入口 ---------------- */

int APIENTRY WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmdLine, int nCmdShow) {
    (void)hPrev;
    (void)lpCmdLine;
    (void)nCmdShow;

    DWORD n = GetModuleFileNameW(NULL, g_dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) {
        fatal(L"取不到程序所在目录。");
        return 1;
    }
    wchar_t *slash = wcsrchr(g_dir, L'\\');
    if (!slash) {
        fatal(L"取不到程序所在目录。");
        return 1;
    }
    *slash = L'\0';

    _snwprintf(g_data, MAX_PATH, L"%s\\app\\data", g_dir);
    CreateDirectoryW(g_data, NULL);
    _snwprintf(g_log, MAX_PATH, L"%s\\ocs.log", g_data);

    /* 已经有一份在跑：只把浏览器再开一次，然后自己退出 */
    HANDLE mtx = CreateMutexW(NULL, TRUE, L"Local\\OCS-WebAssistant-Launcher");
    if (mtx && GetLastError() == ERROR_ALREADY_EXISTS) {
        openConsole();
        CloseHandle(mtx);
        return 0;
    }

    g_taskbarMsg = RegisterWindowMessageW(L"TaskbarCreated");

    WNDCLASSEXW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = L"OCSWebAssistantTray";
    if (!RegisterClassExW(&wc)) {
        fatal(L"创建窗口类失败，程序无法启动。");
        return 1;
    }

    /* 普通顶层窗口 + 不 Show，收得到 TaskbarCreated 广播，又不会出现在任务栏 */
    g_hwnd = CreateWindowExW(0, wc.lpszClassName, L"OCS 网课助手", WS_OVERLAPPED,
                             0, 0, 0, 0, NULL, NULL, hInst, NULL);
    if (!g_hwnd) {
        fatal(L"创建窗口失败，程序无法启动。");
        return 1;
    }

    trayAdd();

    if (!startNode()) {
        trayRemove();
        DestroyWindow(g_hwnd);
        if (mtx) CloseHandle(mtx);
        return 1;
    }
    balloon(L"已在后台运行。双击图标打开控制台，右键可以退出。", NIIF_INFO);

    HANDLE wait[1];
    MSG msg;
    for (;;) {
        DWORD count = g_proc ? 1 : 0;
        if (g_proc) wait[0] = g_proc;

        DWORD r = MsgWaitForMultipleObjects(count, wait, FALSE, INFINITE, QS_ALLINPUT);
        if (count && r == WAIT_OBJECT_0) {
            onNodeExit();
            if (g_exiting) break;
            continue;
        }
        if (r == WAIT_FAILED) break;

        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) {
                g_exiting = TRUE;
                break;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (g_exiting) break;
    }

    trayRemove();
    stopNode();
    if (mtx) CloseHandle(mtx);
    return 0;
}
