/*
 * OCS 网课助手 · Windows 启动器
 *
 * 双击后：
 *   1. 打开一个控制台窗口（能看到日志，关掉窗口就等于停服务）；
 *   2. 用自带的 node.exe 跑 app\launch.js；
 *   3. launch.js 起服务并自动打开浏览器。
 *
 * 之所以不用 .bat：中文路径、窗口标题、图标、错误提示都不好处理。
 */
#include <windows.h>
#include <stdio.h>

static void fatal(const wchar_t *msg) {
    MessageBoxW(NULL, msg, L"OCS 网课助手", MB_OK | MB_ICONERROR);
}

int main(void) {
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleTitleW(L"OCS 网课助手 · 关闭此窗口即停止服务");

    wchar_t dir[MAX_PATH];
    DWORD n = GetModuleFileNameW(NULL, dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) {
        fatal(L"取不到程序所在目录。");
        return 1;
    }
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (!slash) {
        fatal(L"取不到程序所在目录。");
        return 1;
    }
    *slash = L'\0';

    wchar_t node[MAX_PATH];
    wchar_t script[MAX_PATH];
    _snwprintf(node, MAX_PATH, L"%s\\node.exe", dir);
    _snwprintf(script, MAX_PATH, L"%s\\app\\launch.js", dir);

    if (GetFileAttributesW(node) == INVALID_FILE_ATTRIBUTES) {
        fatal(L"找不到 node.exe。\n\n安装可能不完整，请重新运行安装程序。");
        return 1;
    }
    if (GetFileAttributesW(script) == INVALID_FILE_ATTRIBUTES) {
        fatal(L"找不到 app\\launch.js。\n\n安装可能不完整，请重新运行安装程序。");
        return 1;
    }

    // CreateProcessW 要求可写缓冲区
    wchar_t cmdline[MAX_PATH * 4];
    _snwprintf(cmdline, MAX_PATH * 4, L"\"%s\" \"%s\"", node, script);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    // 继承控制台：node 的输出直接落在这个窗口里
    if (!CreateProcessW(node, cmdline, NULL, NULL, TRUE, 0, NULL, dir, &si, &pi)) {
        wchar_t buf[256];
        _snwprintf(buf, 256, L"启动 node.exe 失败（错误码 %lu）。", GetLastError());
        fatal(buf);
        return 1;
    }

    // 把 node 绑进 Job：这个窗口一关（或启动器被结束），node 一定跟着退出，
    // 不然用户关了窗口，后台还留一个进程占着 8899，下次启动会以为「已经有一份在跑」。
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
        ZeroMemory(&jeli, sizeof(jeli));
        jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
        AssignProcessToJobObject(job, pi.hProcess);
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    if (code != 0) {
        wprintf(L"\n[node 退出码 %lu]\n", code);
        system("pause");
    }
    return (int)code;
}
